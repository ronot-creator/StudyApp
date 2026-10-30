use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../mcp-server/src/server.py");
    println!("cargo:rerun-if-changed=../mcp-server/build_sidecar.py");

    let win_sidecar = Path::new("bin/mcp-sidecar-x86_64-pc-windows-msvc.exe");
    let linux_sidecar = Path::new("bin/mcp-sidecar-x86_64-unknown-linux-gnu");
    if !win_sidecar.exists() && !linux_sidecar.exists() {
        let _ = Command::new("python3")
            .arg("../mcp-server/build_sidecar.py")
            .status();
    }

    tauri_build::build()
}
