"""Dynamic OS $APPLOCALDATA Path Sandbox & 500 GB Quota Enforcement for Convergence."""
import os
import re
import shutil
import tempfile
from pathlib import Path, PureWindowsPath
from typing import Union


def resolve_default_appdata_dir() -> Path:
    """Resolves the dynamic OS AppLocalData root directory without hardcoded E:\\ drive paths."""
    for env_key in ("CONVERGENCE_APPDATA_DIR", "STUDYAPP_APPDATA_DIR"):
        val = os.environ.get(env_key, "").strip()
        if val:
            return Path(val).resolve()

    local_appdata = os.environ.get("LOCALAPPDATA", "").strip()
    if local_appdata:
        return (Path(local_appdata) / "com.convergence.studyapp").resolve()

    appdata = os.environ.get("APPDATA", "").strip()
    if appdata:
        return (Path(appdata) / "com.convergence.studyapp").resolve()

    xdg = os.environ.get("XDG_DATA_HOME", "").strip()
    if xdg:
        return (Path(xdg) / "com.convergence.studyapp").resolve()

    return (Path.home() / ".local" / "share" / "com.convergence.studyapp").resolve()


SANDBOX_ROOT = resolve_default_appdata_dir()
VAULT_DIR = SANDBOX_ROOT / "vault"
IMAGES_DIR = SANDBOX_ROOT / "images"
SRS_DATA_DIR = SANDBOX_ROOT / "srs_data"
DB_PATH = SRS_DATA_DIR / "studyapp_srs.db"


def ensure_appdata_directories(root: Union[str, Path, None] = None) -> Path:
    """Automatically provisions vault, images, and srs_data inside $APPLOCALDATA on startup."""
    base = Path(root) if root is not None else Path(SANDBOX_ROOT)
    for sub in ("vault", "images", "srs_data"):
        (base / sub).mkdir(parents=True, exist_ok=True)
    return base


ensure_appdata_directories()

MAX_PARTITION_BYTES = 500 * (1024 ** 3)  # 500 GB capacity cap
MIN_FREE_RESERVE_BYTES = 5 * (1024 ** 3)  # 5 GB mandatory reserve inside that cap
USABLE_CAP_BYTES = MAX_PARTITION_BYTES - MIN_FREE_RESERVE_BYTES

_GB = 1024 ** 3


class QuotaExceededError(OSError):
    """Raised when a write would break the 500 GB cap / 5 GB reserve guardrail."""


def resolve_sandboxed_path(relative_or_abs: Union[str, Path]) -> Path:
    """Ensures the target path resolves strictly inside the dynamic AppLocalData SANDBOX_ROOT.

    Uses ``Path.is_relative_to`` (component-wise), so sibling directories that merely share a
    string prefix and ``..`` traversal are rejected.
    """
    root = Path(SANDBOX_ROOT).resolve()
    ensure_appdata_directories(root)
    rel_str = str(relative_or_abs)

    if rel_str.startswith("$APPLOCALDATA"):
        rel_str = rel_str[len("$APPLOCALDATA"):].lstrip("/\\")

    if not isinstance(relative_or_abs, str) or (os.name != "nt" and rel_str.startswith(str(root))):
        candidate = (root / relative_or_abs).resolve()
        if not candidate.is_relative_to(root):
            raise PermissionError(
                f"Convergence Sandbox Violation: '{relative_or_abs}' escapes {root}"
            )
        return candidate

    parts = [p for p in re.split(r"[\\/]+", rel_str) if p]
    if ".." in parts:
        raise PermissionError(
            f"Convergence Sandbox Violation: '{relative_or_abs}' escapes {root}"
        )

    if re.match(r"^[A-Za-z]:[\\/]", rel_str):
        win_path = PureWindowsPath(rel_str)
        try:
            win_root = PureWindowsPath(str(root))
            rel_under_win = win_path.relative_to(win_root)
        except ValueError:
            raise PermissionError(
                f"Convergence Sandbox Violation: '{relative_or_abs}' escapes {root}"
            )
        candidate = (root / Path(*rel_under_win.parts)).resolve()
    else:
        norm_rel = rel_str.replace("\\", "/")
        candidate = (root / norm_rel).resolve()

    if not candidate.is_relative_to(root):
        raise PermissionError(
            f"Convergence Sandbox Violation: '{relative_or_abs}' escapes {root}"
        )
    return candidate


def directory_size(path: Path) -> int:
    """Total size in bytes of all regular files under ``path`` (0 if it does not exist)."""
    path = Path(path)
    if not path.exists():
        return 0
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                continue
    return total


def _existing_ancestor(path: Path) -> Path:
    for candidate in (path, *path.parents):
        if candidate.exists():
            return candidate
    return Path(".").resolve()


def check_disk_quota(additional_bytes: int = 0) -> dict:
    """Verifies a pending write against the 500 GB cap and the 5 GB reserve."""
    if additional_bytes < 0:
        raise ValueError("additional_bytes must be non-negative")

    root = Path(SANDBOX_ROOT)
    used = directory_size(root)
    if used + additional_bytes > USABLE_CAP_BYTES:
        raise QuotaExceededError(
            f"Quota Guardrail Triggered: sandbox would use {(used + additional_bytes) / _GB:.2f} GB "
            f"of the {USABLE_CAP_BYTES / _GB:.2f} GB usable cap "
            f"(500 GB minus {MIN_FREE_RESERVE_BYTES / _GB:.0f} GB reserve)."
        )

    usage = shutil.disk_usage(_existing_ancestor(root))
    effective_reserve = (
        MIN_FREE_RESERVE_BYTES
        if usage.total >= MIN_FREE_RESERVE_BYTES * 4
        else min(MIN_FREE_RESERVE_BYTES, int(usage.total * 0.05))
    )
    if usage.free - additional_bytes < effective_reserve:
        raise QuotaExceededError(
            f"Disk Guardrail Triggered: only {(usage.free - additional_bytes) / _GB:.2f} GB would "
            f"remain free on the drive (minimum {MIN_FREE_RESERVE_BYTES / _GB:.2f} GB reserve)."
        )

    return {
        "cap_gb": round(USABLE_CAP_BYTES / _GB, 2),
        "used_gb": round(used / _GB, 4),
        "remaining_gb": round((USABLE_CAP_BYTES - used - additional_bytes) / _GB, 2),
        "free_gb": round(usage.free / _GB, 2),
        "total_gb": round(usage.total / _GB, 2),
    }


def safe_write_text(path: Union[str, Path], text: str, encoding: str = "utf-8") -> Path:
    """Quota-checked, sandbox-checked, atomic text write (temp file + ``os.replace``)."""
    target = resolve_sandboxed_path(path)
    existing = target.stat().st_size if target.exists() else 0
    new_bytes = len(text.encode(encoding))
    check_disk_quota(max(0, new_bytes - existing))
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=f".{target.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding=encoding) as handle:
            handle.write(text)
        os.replace(tmp_name, target)
    except Exception:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)
        raise
    return target
