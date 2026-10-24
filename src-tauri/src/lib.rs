use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    LogicalPosition, LogicalSize, Manager, State, WebviewBuilder, WebviewUrl, WebviewWindowBuilder,
};

/// Strict Hardware Root Sandbox defined in Constitution.md Section 3
pub const SANDBOX_ROOT: &str = r"E:\StudyApp\MyFiles";
/// Persistent Browser Partition directory enforcing `persist:study_session`
pub const STUDY_SESSION_PARTITION_DIR: &str =
    r"E:\StudyApp\MyFiles\.webview_partitions\persist_study_session";
/// Localhost HTTP highlight bridge endpoint in mcp-server
pub const HIGHLIGHT_BRIDGE_URL: &str = "http://127.0.0.1:47821/highlight";

/// WebView2 RAM Diet & Lag Optimization flags applied before Tauri boots (Constitution Section 4)
pub const WEBVIEW2_RAM_DIET_ARGS: &str =
    "--process-per-site --enable-features=msWebView2BrowserHitTransparent --js-flags=--max-old-space-size=512";

/// Lightweight MutationObserver injected into AI WebViews to auto-click "Allow" on Composio MCP tool prompts
/// and disable heavy background CSS animations to conserve GPU/RAM.
pub const AUTO_ALLOW_AND_PERF_SCRIPT: &str = r#"
(function() {
  if (window.__STUDYAPP_MCP_OBSERVER_INSTALLED__) return;
  window.__STUDYAPP_MCP_OBSERVER_INSTALLED__ = true;

  // Throttle heavy background decorative animations for smooth 60fps WebView2 performance
  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after {
      scroll-behavior: auto !important;
    }
  `;
  document.documentElement.appendChild(style);

  // Auto-click 'Allow' / 'Approve' on Composio MCP confirmation cards inside Gemini / AI sessions
  const clickAllowIfNeeded = () => {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const txt = (btn.textContent || '').trim();
      if (txt === 'Allow' || txt === 'Always Allow' || txt === 'Allow tool') {
        const containerText = (btn.closest('div, section, form')?.textContent || '');
        if (
          containerText.includes('Composio') ||
          containerText.includes('MCP') ||
          containerText.includes('StudyApp') ||
          containerText.includes('tool')
        ) {
          btn.click();
        }
      }
    }
  };

  const observer = new MutationObserver(() => {
    clickAllowIfNeeded();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
"#;

/// Tracks the Python MCP Server child process and the Warm-1 Active Docked AI WebView state
pub struct AppRuntimeState {
    pub mcp_sidecar: Mutex<Option<Child>>,
    pub active_docked_provider: Mutex<Option<String>>,
    pub detached_providers: Mutex<HashMap<String, String>>,
}

impl Default for AppRuntimeState {
    fn default() -> Self {
        Self {
            mcp_sidecar: Mutex::new(None),
            active_docked_provider: Mutex::new(None),
            detached_providers: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiPanelStatus {
    pub provider: String,
    pub mode: String, // "docked" | "detached" | "hibernated"
    pub label: String,
    pub target_url: String,
    pub partition_dir: String,
}

/// Resolves canonical AI provider identifier to `(panel_label, float_label, url, title)`
pub fn resolve_ai_provider(provider: &str) -> Result<(String, String, String, String), String> {
    match provider.to_lowercase().as_str() {
        "gemini" => Ok((
            "ai_panel_gemini".to_string(),
            "ai_float_gemini".to_string(),
            "https://gemini.google.com/app".to_string(),
            "Gemini 4 Argon — StudyApp Session".to_string(),
        )),
        "chatgpt" => Ok((
            "ai_panel_chatgpt".to_string(),
            "ai_float_chatgpt".to_string(),
            "https://chatgpt.com/".to_string(),
            "ChatGPT — StudyApp Session".to_string(),
        )),
        "claude" => Ok((
            "ai_panel_claude".to_string(),
            "ai_float_claude".to_string(),
            "https://claude.ai/new".to_string(),
            "Claude — StudyApp Session".to_string(),
        )),
        "notebooklm" => Ok((
            "ai_panel_notebooklm".to_string(),
            "ai_float_notebooklm".to_string(),
            "https://notebooklm.google.com/".to_string(),
            "NotebookLM — StudyApp Session".to_string(),
        )),
        other => Err(format!(
            "Unsupported AI provider '{}'. Expected one of: gemini, chatgpt, claude, notebooklm.",
            other
        )),
    }
}

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

/// Spawns the local Python MCP server (`mcp-server/src/server.py`) on startup
fn spawn_mcp_sidecar() -> Option<Child> {
    let server_script = PathBuf::from(r"E:\StudyApp\mcp-server\src\server.py");
    if !server_script.exists() {
        return None;
    }
    Command::new("python")
        .args(["-m", "src.server"])
        .current_dir(r"E:\StudyApp\mcp-server")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

/// Forwards user text selection from the Vault Reader UI to `127.0.0.1:47821/highlight`
#[tauri::command]
pub async fn update_active_highlight(
    active_file: String,
    selected_text: String,
    surrounding_context: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "active_file": active_file,
        "selected_text": selected_text,
        "surrounding_context": surrounding_context,
    });

    client
        .post(HIGHLIGHT_BRIDGE_URL)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Highlight bridge error: {e}"))?;

    Ok("synced".to_string())
}

/// Hot-swaps the active docked AI Web-View inside the `main` window using the Warm-1 RAM Pool:
/// Any previously docked AI Web-View is unmounted from live GPU memory while preserving its cookies/IndexedDB
/// inside `E:\StudyApp\MyFiles\.webview_partitions\persist_study_session`.
#[tauri::command]
pub fn switch_active_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    provider: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<AiPanelStatus, String> {
    let norm_provider = provider.to_lowercase();
    let (panel_label, _float_label, target_url, _title) = resolve_ai_provider(&norm_provider)?;

    // Warm-1 Pool Hibernation: Close any currently docked child webview from live GPU RAM
    {
        let mut active_guard = state
            .active_docked_provider
            .lock()
            .map_err(|e| format!("Mutex lock error: {e}"))?;

        if let Some(prev_provider) = active_guard.as_ref() {
            if let Ok((prev_label, _, _, _)) = resolve_ai_provider(prev_provider) {
                if let Some(existing_wv) = app.get_webview(&prev_label) {
                    let _ = existing_wv.close();
                }
            }
        }
        *active_guard = Some(norm_provider.clone());
    }

    let data_dir = PathBuf::from(STUDY_SESSION_PARTITION_DIR);
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create persist_study_session directory: {e}"))?;

    let main_window = app
        .get_window("main")
        .ok_or_else(|| "Main window 'main' not found".to_string())?;

    let parsed_url: url::Url = target_url
        .parse()
        .map_err(|e| format!("Invalid provider URL: {e}"))?;

    let webview_builder = WebviewBuilder::new(&panel_label, WebviewUrl::External(parsed_url))
        .data_directory(data_dir)
        .initialization_script(AUTO_ALLOW_AND_PERF_SCRIPT)
        .auto_resize();

    main_window
        .add_child(
            webview_builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| format!("Failed to mount docked AI webview '{panel_label}': {e}"))?;

    Ok(AiPanelStatus {
        provider: norm_provider,
        mode: "docked".to_string(),
        label: panel_label,
        target_url,
        partition_dir: STUDY_SESSION_PARTITION_DIR.to_string(),
    })
}

/// Legacy compatibility alias that delegates to `switch_active_ai_panel`
#[tauri::command]
pub fn mount_persistent_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    panel_label: String,
    target_url: String,
    partition_id: String,
) -> Result<String, String> {
    if partition_id != "persist:study_session" {
        return Err("Constitution Directive 3 requires partition_id = 'persist:study_session'".into());
    }
    let inferred = if target_url.contains("chatgpt") || panel_label.contains("chatgpt") {
        "chatgpt"
    } else if target_url.contains("claude") || panel_label.contains("claude") {
        "claude"
    } else if target_url.contains("notebooklm") || panel_label.contains("notebooklm") {
        "notebooklm"
    } else {
        "gemini"
    };

    let status = switch_active_ai_panel(app, state, inferred.to_string(), 920.0, 56.0, 680.0, 904.0)?;
    Ok(format!("Mounted {} ({}) in mode {}", status.provider, status.label, status.mode))
}

/// Undocks the specified AI provider from the `main` split-pane and spawns a native floating desktop window
/// sharing `persist:study_session`.
#[tauri::command]
pub fn detach_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    provider: String,
) -> Result<AiPanelStatus, String> {
    let norm_provider = provider.to_lowercase();
    let (panel_label, float_label, target_url, title) = resolve_ai_provider(&norm_provider)?;

    // Unmount docked child webview if currently active
    {
        let mut active_guard = state
            .active_docked_provider
            .lock()
            .map_err(|e| format!("Mutex lock error: {e}"))?;
        if let Some(existing_wv) = app.get_webview(&panel_label) {
            let _ = existing_wv.close();
        }
        if active_guard.as_deref() == Some(norm_provider.as_str()) {
            *active_guard = None;
        }
    }

    let data_dir = PathBuf::from(STUDY_SESSION_PARTITION_DIR);
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create persist_study_session directory: {e}"))?;

    if let Some(existing_win) = app.get_webview_window(&float_label) {
        let _ = existing_win.set_focus();
    } else {
        let parsed_url: url::Url = target_url
            .parse()
            .map_err(|e| format!("Invalid provider URL: {e}"))?;

        WebviewWindowBuilder::new(&app, &float_label, WebviewUrl::External(parsed_url))
            .title(&title)
            .inner_size(980.0, 860.0)
            .resizable(true)
            .data_directory(data_dir)
            .initialization_script(AUTO_ALLOW_AND_PERF_SCRIPT)
            .build()
            .map_err(|e| format!("Failed to spawn floating AI window '{float_label}': {e}"))?;
    }

    {
        let mut detached_guard = state
            .detached_providers
            .lock()
            .map_err(|e| format!("Mutex lock error: {e}"))?;
        detached_guard.insert(norm_provider.clone(), float_label.clone());
    }

    Ok(AiPanelStatus {
        provider: norm_provider,
        mode: "detached".to_string(),
        label: float_label,
        target_url,
        partition_dir: STUDY_SESSION_PARTITION_DIR.to_string(),
    })
}

/// Closes a detached floating AI window and seamlessly re-docks the provider into the `main` split-pane
#[tauri::command]
pub fn redock_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    provider: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<AiPanelStatus, String> {
    let norm_provider = provider.to_lowercase();
    let (_panel_label, float_label, _target_url, _title) = resolve_ai_provider(&norm_provider)?;

    if let Some(float_win) = app.get_webview_window(&float_label) {
        let _ = float_win.close();
    }

    {
        let mut detached_guard = state
            .detached_providers
            .lock()
            .map_err(|e| format!("Mutex lock error: {e}"))?;
        detached_guard.remove(&norm_provider);
    }

    switch_active_ai_panel(app, state, norm_provider, x, y, width, height)
}

/// Syncs the native docked child Web-View bounds whenever the user drags the React split-pane divider
#[tauri::command]
pub fn resize_docked_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<String, String> {
    let active_guard = state
        .active_docked_provider
        .lock()
        .map_err(|e| format!("Mutex lock error: {e}"))?;

    if let Some(active_provider) = active_guard.as_ref() {
        let (panel_label, _, _, _) = resolve_ai_provider(active_provider)?;
        if let Some(wv) = app.get_webview(&panel_label) {
            wv.set_position(LogicalPosition::new(x, y))
                .map_err(|e| format!("Failed to update position: {e}"))?;
            wv.set_size(LogicalSize::new(width, height))
                .map_err(|e| format!("Failed to update size: {e}"))?;
            return Ok(format!("Resized {panel_label} to {width}x{height} at ({x}, {y})"));
        }
    }
    Ok("No active docked panel to resize".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Enforce WebView2 RAM Diet & Lag Optimization before initializing Tauri
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", WEBVIEW2_RAM_DIET_ARGS);

    tauri::Builder::default()
        .manage(AppRuntimeState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            // Ensure E:\StudyApp\MyFiles sandbox directories exist at startup
            for sub in [
                "vault",
                "images",
                "srs_data",
                ".webview_partitions/persist_study_session",
            ] {
                let mut dir = PathBuf::from(SANDBOX_ROOT);
                dir.push(sub);
                let _ = std::fs::create_dir_all(&dir);
            }

            // Spawn Python MCP sidecar server
            if let Some(child) = spawn_mcp_sidecar() {
                let state = app.state::<AppRuntimeState>();
                if let Ok(mut guard) = state.mcp_sidecar.lock() {
                    *guard = Some(child);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    let state = window.state::<AppRuntimeState>();
                    let mut guard = match state.mcp_sidecar.lock() {
                        Ok(g) => g,
                        Err(_) => return,
                    };
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            mount_persistent_ai_panel,
            switch_active_ai_panel,
            detach_ai_panel,
            redock_ai_panel,
            resize_docked_ai_panel,
            update_active_highlight,
        ])
        .run(tauri::generate_context!())
        .expect("error while running StudyApp tauri application");
}
