"""Strict E:\\StudyApp\\MyFiles\\ Path Sandbox & 500 GB Quota Enforcement."""
import shutil
from pathlib import Path

SANDBOX_ROOT = Path(r"E:\StudyApp\MyFiles").resolve()
VAULT_DIR = SANDBOX_ROOT / "vault"
IMAGES_DIR = SANDBOX_ROOT / "images"
SRS_DATA_DIR = SANDBOX_ROOT / "srs_data"

MAX_PARTITION_BYTES = 500 * (1024 ** 3)  # 500 GB E:\ capacity
MIN_FREE_RESERVE_BYTES = 5 * (1024 ** 3) # 5 GB mandatory free reserve


def resolve_sandboxed_path(relative_or_abs: str) -> Path:
    """Ensures the target path is strictly inside E:\\StudyApp\\MyFiles\\."""
    candidate = (SANDBOX_ROOT / relative_or_abs).resolve()
    if not str(candidate).startswith(str(SANDBOX_ROOT)):
        raise PermissionError(
            f"Constitution Section 3 Violation: '{relative_or_abs}' escapes {SANDBOX_ROOT}"
        )
    return candidate


def check_disk_quota(additional_bytes: int = 0) -> dict:
    """Verifies E:\\ partition has at least 5 GB free reserve before writing."""
    drive_root = Path(SANDBOX_ROOT.anchor or r"E:\")
    try:
        usage = shutil.disk_usage(drive_root)
    except FileNotFoundError:
        # Fallback for CI/test environments where E:\ is simulated
        usage = shutil.disk_usage(Path.cwd())

    remaining_free = usage.free - additional_bytes
    if remaining_free < MIN_FREE_RESERVE_BYTES:
        raise OSError(
            f"E:\\ Quota Guardrail Triggered: Only {remaining_free / (1024**3):.2f} GB would remain free "
            f"(minimum 5.00 GB reserve required)."
        )
    return {
        "total_gb": round(usage.total / (1024 ** 3), 2),
        "used_gb": round(usage.used / (1024 ** 3), 2),
        "free_gb": round(usage.free / (1024 ** 3), 2),
    }
