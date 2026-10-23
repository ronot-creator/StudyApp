use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{LogicalPosition, LogicalSize, Manager, RunEvent, WebviewBuilder, WebviewUrl};

/// Strict Hardware Root Sandbox defined in Constitution.md Section 3
pub const SANDBOX_ROOT: &str = r"E:\StudyApp\MyFiles";
/// Persistent Browser Partition directory enforcing `persist:study_session` (Section 2 & 7)
pub const STUDY_SESSION_PARTITION_DIR: &str = r"E:\StudyApp\MyFiles\.webview_partitions\persist_study_session";

/// Validates that any requested path resides strictly inside `E:\StudyApp\MyFiles\`
pub fn enforce_e_drive_sandbox(candidate: &PathBuf) -> Result<PathBuf, String> {
    let root = PathBuf::from(SANDBOX_ROOT);
    if candidate.starts_with(&root) {
        Ok(candidate.clone())
    } else {
        Err(format!(
            "Constitution Violation: Path {:?} is outside the E:\\StudyApp\\MyFiles sandbox.",
            candidate
        ))
    }
}

/// Mounts a persistent authenticated AI WebView panel (Gemini / NotebookLM)
/// using the dedicated `persist:study_session` data directory on E:\ so Google auth survives app restarts.
#[tauri::command]
fn mount_persistent_ai_panel(
    app: tauri::AppHandle,
    panel_label: String,
    target_url: String,
    partition_id: String,
) -> Result<String, String> {
    if partition_id != "persist:study_session" {
        return Err("Constitution Directive 3 requires partition_id = 'persist:study_session'".into());
    }

    let data_dir = PathBuf::from(STUDY_SESSION_PARTITION_DIR);
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("Failed to create partition dir: {e}"))?;

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;

    let parsed_url: url::Url = target_url
        .parse()
        .map_err(|e| format!("Invalid target URL: {e}"))?;

    let webview_builder = WebviewBuilder::new(&panel_label, WebviewUrl::External(parsed_url))
        .data_directory(data_dir)
        .auto_resize();

    main_window
        .add_child(
            webview_builder,
            LogicalPosition::new(920.0, 0.0),
            LogicalSize::new(680.0, 960.0),
        )
        .map_err(|e| format!("Failed to mount persistent webview panel: {e}"))?;

    Ok(format!("Mounted {panel_label} with partition {partition_id}"))
}

/// Loopback port of the Python MCP server's highlight bridge (mcp-server/src/server.py)
pub const MCP_BRIDGE_PORT: u16 = 47821;

/// Holds the spawned Python MCP server so it can be terminated on exit.
pub struct McpSidecar(pub Mutex<Option<Child>>);

#[derive(Serialize, Deserialize, Debug)]
pub struct ActiveHighlight {
    pub active_file: String,
    pub selected_text: String,
    pub surrounding_context: String,
}

/// Forwards the Markdown reader's current selection (onMouseUp) to the Python MCP server
/// so `get_active_highlight()` / `save_thought_anchor()` see it.
#[tauri::command]
async fn update_active_highlight(
    active_file: String,
    selected_text: String,
    surrounding_context: String,
) -> Result<(), String> {
    let payload = ActiveHighlight { active_file, selected_text, surrounding_context };
    let resp = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{MCP_BRIDGE_PORT}/highlight"))
        .timeout(Duration::from_secs(3))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("MCP bridge unreachable: {e}"))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("MCP bridge rejected highlight: HTTP {}", resp.status()))
    }
}

/// Spawns `python -m src.server` from the mcp-server directory.
/// Override with STUDYAPP_PYTHON / STUDYAPP_MCP_DIR.
fn spawn_mcp_server() -> std::io::Result<Child> {
    let python = std::env::var("STUDYAPP_PYTHON").unwrap_or_else(|_| "python".into());
    let dir = std::env::var("STUDYAPP_MCP_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("mcp-server"));

    let mut cmd = Command::new(python);
    cmd.args(["-m", "src.server"])
        .current_dir(dir)
        // Keep stdin open: the stdio MCP transport exits when its stdin closes.
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
}

fn stop_mcp_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<McpSidecar>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            drop(child.stdin.take()); // graceful: close stdin so the server can exit
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(McpSidecar(Mutex::new(None)))
        .setup(|app| {
            // Ensure E:\StudyApp\MyFiles sandbox directories exist at startup
            for sub in ["vault", "images", "srs_data", ".webview_partitions/persist_study_session"] {
                let mut dir = PathBuf::from(SANDBOX_ROOT);
                dir.push(sub);
                let _ = std::fs::create_dir_all(&dir);
            }
            match spawn_mcp_server() {
                Ok(child) => *app.state::<McpSidecar>().0.lock().unwrap() = Some(child),
                Err(e) => eprintln!("Failed to start Python MCP server: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mount_persistent_ai_panel,
            update_active_highlight
        ])
        .build(tauri::generate_context!())
        .expect("error while building StudyApp tauri application");

    app.run(|handle, event| {
        if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
            stop_mcp_server(handle);
        }
    });
}