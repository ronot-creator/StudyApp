"""Strict E:\\StudyApp\\MyFiles\\ Path Sandbox Enforcement."""
from pathlib import Path

SANDBOX_ROOT = Path(r"E:\StudyApp\MyFiles").resolve()
VAULT_DIR = SANDBOX_ROOT / "vault"
IMAGES_DIR = SANDBOX_ROOT / "images"
SRS_DATA_DIR = SANDBOX_ROOT / "srs_data"


def resolve_sandboxed_path(relative_or_abs: str) -> Path:
    """Ensures the target path is strictly inside E:\\StudyApp\\MyFiles\\."""
    candidate = (SANDBOX_ROOT / relative_or_abs).resolve()
    if not str(candidate).startswith(str(SANDBOX_ROOT)):
        raise PermissionError(
            f"Constitution Section 3 Violation: '{relative_or_abs}' escapes {SANDBOX_ROOT}"
        )
    return candidate
