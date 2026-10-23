use std::path::PathBuf;
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

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
pub fn mount_persistent_ai_panel(
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|_app| {
            // Ensure E:\StudyApp\MyFiles sandbox directories exist at startup
            for sub in ["vault", "images", "srs_data", ".webview_partitions/persist_study_session"] {
                let mut dir = PathBuf::from(SANDBOX_ROOT);
                dir.push(sub);
                let _ = std::fs::create_dir_all(&dir);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![mount_persistent_ai_panel])
        .run(tauri::generate_context!())
        .expect("error while running StudyApp tauri application");
}
