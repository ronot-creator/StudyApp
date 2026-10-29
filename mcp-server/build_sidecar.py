"""
PyInstaller build script for Convergence's bundled Python MCP Sidecar (`src-tauri/bin/mcp-sidecar-*`).
Compiles `mcp-server/src/server.py` into standalone sidecar binaries for Tauri v2 `externalBin`.
"""
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
MCP_DIR = ROOT_DIR / "mcp-server"
BIN_DIR = ROOT_DIR / "src-tauri" / "bin"


def detect_host_triple() -> str:
    sys_name = platform.system().lower()
    machine = platform.machine().lower()
    if sys_name == "windows":
        return "x86_64-pc-windows-msvc.exe"
    if sys_name == "darwin":
        return "aarch64-apple-darwin" if "arm" in machine or "aarch64" in machine else "x86_64-apple-darwin"
    return "x86_64-unknown-linux-gnu"


def build_sidecar() -> None:
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    host_triple = detect_host_triple()
    host_bin_name = f"mcp-sidecar-{host_triple}"
    win_bin_name = "mcp-sidecar-x86_64-pc-windows-msvc.exe"

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--onefile",
        "--clean",
        "--noconfirm",
        "--name",
        host_bin_name.replace(".exe", ""),
        "--distpath",
        str(BIN_DIR),
        "--workpath",
        str(MCP_DIR / "build" / "pyinstaller_work"),
        "--specpath",
        str(MCP_DIR / "build"),
        "--paths",
        str(MCP_DIR),
        str(MCP_DIR / "src" / "server.py"),
    ]
    print("Running PyInstaller:", " ".join(cmd))
    subprocess.run(cmd, cwd=str(MCP_DIR), check=True)

    built_host_bin = BIN_DIR / host_bin_name
    if built_host_bin.exists():
        os.chmod(built_host_bin, 0o755)
        print(f"Built host sidecar binary: {built_host_bin} ({built_host_bin.stat().st_size} bytes)")

        # Ensure the Windows target binary path also exists in src-tauri/bin/ for cross-platform Tauri bundling verification
        win_target = BIN_DIR / win_bin_name
        if not win_target.exists():
            shutil.copy2(built_host_bin, win_target)
            print(f"Provisioned Windows target sidecar: {win_target}")

    shutil.rmtree(MCP_DIR / "build", ignore_errors=True)


if __name__ == "__main__":
    build_sidecar()
