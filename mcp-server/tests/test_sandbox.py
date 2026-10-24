"""Tests for sandbox path canonicalization and security."""
import pytest
from pathlib import Path
import tempfile
import os

from src import sandbox


class TestSandboxPathCanonicalization:
    """Test that Path.is_relative_to() is used for secure sandbox enforcement."""

    def test_accepts_paths_inside_sandbox(self):
        """Paths inside the sandbox should be accepted."""
        assert sandbox.resolve_sandboxed_path("vault/note.md").name == "note.md"
        assert sandbox.resolve_sandboxed_path("images/diagram.png").name == "diagram.png"
        assert sandbox.resolve_sandboxed_path("srs_data/studyapp_srs.db").name == "studyapp_srs.db"

    def test_rejects_parent_traversal(self):
        """Paths using ../ should be rejected."""
        with pytest.raises(PermissionError):
            sandbox.resolve_sandboxed_path("../secrets.txt")
        with pytest.raises(PermissionError):
            sandbox.resolve_sandboxed_path("vault/../../outside.md")
        with pytest.raises(PermissionError):
            sandbox.resolve_sandboxed_path("..\\..\\Windows\\win.ini")

    def test_rejects_sibling_prefix_attack(self):
        """Paths with sibling directory prefix (MyFiles_evil) should be rejected when they resolve."""
        # For non-existent paths, the check works on the resolved path
        # Create the sibling directory structure to test
        sandbox_root = Path(sandbox.SANDBOX_ROOT)
        evil_dir = sandbox_root.parent / "MyFiles_evil"
        evil_dir.mkdir(exist_ok=True)
        (evil_dir / "x.md").write_text("evil")

        try:
            with pytest.raises(PermissionError):
                sandbox.resolve_sandboxed_path(r"E:\StudyApp\MyFiles_evil\x.md")
        finally:
            import shutil
            shutil.rmtree(evil_dir, ignore_errors=True)

    def test_rejects_absolute_outside_paths(self):
        """Absolute paths outside sandbox should be rejected."""
        with pytest.raises(PermissionError):
            sandbox.resolve_sandboxed_path(r"C:\Windows\win.ini")
        with pytest.raises(PermissionError):
            sandbox.resolve_sandboxed_path(r"D:\data\file.txt")

    def test_rejects_symlink_traversal(self, tmp_path):
        """Symlinks pointing outside sandbox should be rejected."""
        # Skip on Windows if symlinks not supported
        try:
            sandbox_root = Path(sandbox.SANDBOX_ROOT)
            link_path = sandbox_root / "vault" / "link_outside"
            target_outside = tmp_path / "outside.txt"
            target_outside.write_text("secret")
            link_path.symlink_to(target_outside)

            # The resolved path should be outside sandbox
            with pytest.raises(PermissionError):
                sandbox.resolve_sandboxed_path("vault/link_outside")
        except (OSError, NotImplementedError):
            pytest.skip("Symlinks not supported on this platform")

    def test_accepts_absolute_paths_inside_sandbox(self):
        """Absolute paths that resolve inside sandbox should be accepted."""
        abs_path = str(Path(sandbox.SANDBOX_ROOT) / "vault" / "note.md")
        result = sandbox.resolve_sandboxed_path(abs_path)
        assert result.name == "note.md"

    def test_case_sensitivity_on_windows(self):
        """Windows paths with different case should work."""
        # Windows is case-insensitive but Path.is_relative_to handles this
        result = sandbox.resolve_sandboxed_path("VAULT/note.md")
        assert result.name == "note.md"


class TestQuotaEnforcement:
    """Test disk quota guardrails."""

    def test_quota_blocks_oversized_write(self):
        """Writing more than usable cap should raise QuotaExceededError."""
        with pytest.raises(sandbox.QuotaExceededError):
            sandbox.check_disk_quota(10**15)  # 1 PB
        with pytest.raises(sandbox.QuotaExceededError):
            sandbox.check_disk_quota(600 * 1024**3)  # 600 GB

    def test_safe_write_text_works(self, tmp_path):
        """Normal writes should work."""
        # Use tmp_path as sandbox root for this test
        import src.sandbox as sandbox_mod
        original_root = sandbox_mod.SANDBOX_ROOT
        sandbox_mod.SANDBOX_ROOT = str(tmp_path)
        sandbox_mod.VAULT_DIR = tmp_path / "vault"
        sandbox_mod.IMAGES_DIR = tmp_path / "images"
        sandbox_mod.SRS_DATA_DIR = tmp_path / "srs_data"
        sandbox_mod.VAULT_DIR.mkdir(parents=True)
        sandbox_mod.IMAGES_DIR.mkdir()
        sandbox_mod.SRS_DATA_DIR.mkdir()

        try:
            sandbox.safe_write_text(tmp_path / "vault" / "test.md", "hello")
            assert (tmp_path / "vault" / "test.md").read_text() == "hello"
        finally:
            sandbox_mod.SANDBOX_ROOT = original_root


class TestDiskSpaceCheck:
    """Test physical disk space guardrail."""

    def test_check_disk_quota_validates_free_space(self):
        """Check that disk space validation runs without error for reasonable sizes."""
        # Should not raise for small sizes
        result = sandbox.check_disk_quota(1024)  # 1 KB
        assert "free_gb" in result
        assert result["free_gb"] > 0