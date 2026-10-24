"""Strict E:\\StudyApp\\MyFiles\\ Path Sandbox & 500 GB Quota Enforcement."""
import os
import shutil
import tempfile
from pathlib import Path
from typing import Union

SANDBOX_ROOT = Path(r"E:\StudyApp\MyFiles").resolve()
VAULT_DIR = SANDBOX_ROOT / "vault"
IMAGES_DIR = SANDBOX_ROOT / "images"
SRS_DATA_DIR = SANDBOX_ROOT / "srs_data"

MAX_PARTITION_BYTES = 500 * (1024 ** 3)  # 500 GB E:\ capacity cap
MIN_FREE_RESERVE_BYTES = 5 * (1024 ** 3)  # 5 GB mandatory reserve inside that cap
# Bytes the sandbox may actually occupy: the 500 GB cap minus the 5 GB reserve.
USABLE_CAP_BYTES = MAX_PARTITION_BYTES - MIN_FREE_RESERVE_BYTES

_GB = 1024 ** 3


class QuotaExceededError(OSError):
    """Raised when a write would break the 500 GB cap / 5 GB reserve guardrail."""


def resolve_sandboxed_path(relative_or_abs: Union[str, Path]) -> Path:
    """Ensures the target path is strictly inside E:\\StudyApp\\MyFiles\\.

    Uses ``Path.is_relative_to`` (component-wise), so sibling directories that merely share a
    string prefix (``MyFiles_evil``) and ``..`` traversal are rejected.
    """
    root = Path(SANDBOX_ROOT)
    candidate = (root / relative_or_abs).resolve()
    if not candidate.is_relative_to(root):
        raise PermissionError(
            f"Constitution Section 3 Violation: '{relative_or_abs}' escapes {root}"
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
    raise FileNotFoundError(f"Drive for sandbox root {path} is not available")


def check_disk_quota(additional_bytes: int = 0) -> dict:
    """Verifies a pending write against the true 500 GB cap and the 5 GB reserve.

    Two independent limits must hold:
      1. Sandbox usage (bytes currently under ``SANDBOX_ROOT``) + the write must stay within
         ``500 GB - 5 GB`` (the cap net of the reserve).
      2. The physical drive must still have at least 5 GB free after the write.
    """
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
    if usage.free - additional_bytes < MIN_FREE_RESERVE_BYTES:
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
    # Only the delta counts if we are overwriting an existing file.
    existing = target.stat().st_size if target.exists() else 0
    new_bytes = len(text.encode(encoding))
    check_disk_quota(max(0, new_bytes - existing))
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(target.parent), prefix=".tmp_", suffix=target.suffix)
    try:
        with os.fdopen(fd, "w", encoding=encoding, newline="") as fh:
            fh.write(text)
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise
    return target
