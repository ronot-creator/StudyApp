"""Strict E:\\StudyApp\\MyFiles\\ Path Sandbox Enforcement + E:\\ partition quota guardrails."""
import shutil
from pathlib import Path

SANDBOX_ROOT = Path(r"E:\StudyApp\MyFiles").resolve()
VAULT_DIR = SANDBOX_ROOT / "vault"
IMAGES_DIR = SANDBOX_ROOT / "images"
SRS_DATA_DIR = SANDBOX_ROOT / "srs_data"
DB_PATH = SRS_DATA_DIR / "studyapp_srs.db"

# Constitution Section 3: E:\ partition is 0.5 TB (500 GB).
PARTITION_ROOT = "E:\\"
PARTITION_QUOTA_BYTES = 500 * 1024**3
# Always keep headroom free on the HDD so the OS / SQLite WAL never starve.
MIN_FREE_RESERVE_BYTES = 5 * 1024**3


class QuotaExceededError(OSError):
    """Raised when a write would violate the 500 GB E:\\ partition guardrails."""


def resolve_sandboxed_path(relative_or_abs: str) -> Path:
    """Ensures the target path is strictly inside E:\\StudyApp\\MyFiles\\."""
    candidate = (SANDBOX_ROOT / relative_or_abs).resolve()
    try:
        candidate.relative_to(SANDBOX_ROOT)
    except ValueError:
        raise PermissionError(
            f"Constitution Section 3 Violation: '{relative_or_abs}' escapes {SANDBOX_ROOT}"
        )
    return candidate


def check_disk_quota(incoming_bytes: int = 0) -> None:
    """Pre-write guardrail: raises QuotaExceededError if writing `incoming_bytes`
    would push the E:\\ partition past its 500 GB quota or below the free-space reserve."""
    root = PARTITION_ROOT if Path(PARTITION_ROOT).exists() else SANDBOX_ROOT.anchor
    usage = shutil.disk_usage(root)
    if usage.free - incoming_bytes < MIN_FREE_RESERVE_BYTES:
        raise QuotaExceededError(
            f"E:\\ free space guardrail: {usage.free / 1024**3:.2f} GB free, "
            f"need {incoming_bytes / 1024**3:.3f} GB + {MIN_FREE_RESERVE_BYTES / 1024**3:.0f} GB reserve."
        )
    if usage.used + incoming_bytes > PARTITION_QUOTA_BYTES:
        raise QuotaExceededError(
            f"E:\\ 500 GB quota exceeded: {usage.used / 1024**3:.2f} GB used "
            f"+ {incoming_bytes / 1024**3:.3f} GB incoming."
        )


def safe_write_bytes(path: Path, data: bytes) -> Path:
    """Quota-checked binary write (use for extracted textbook images)."""
    check_disk_quota(len(data))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def safe_write_text(path: Path, text: str) -> Path:
    """Quota-checked UTF-8 text write (use for Markdown chunks)."""
    return safe_write_bytes(path, text.encode("utf-8"))
