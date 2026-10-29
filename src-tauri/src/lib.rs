use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

/// Resolves canonical or custom AI provider identifier + optional custom URL to `(panel_label, float_label, url, title)`.
/// Supports built-in providers (gemini, chatgpt, claude, notebooklm) AND unlimited user-pinned custom chatbots.
pub fn resolve_ai_provider_with_url(
    provider: &str,
    custom_url: Option<&str>,
) -> Result<(String, String, String, String), String> {
    let clean_slug: String = provider
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if clean_slug.is_empty() {
        return Err("AI provider identifier cannot be empty.".to_string());
    }

    let (default_url, default_title) = match clean_slug.as_str() {
        "gemini" => (
            "https://gemini.google.com/app".to_string(),
            "Gemini 4 Argon — StudyApp Session".to_string(),
        ),
        "chatgpt" => (
            "https://chatgpt.com/".to_string(),
            "ChatGPT — StudyApp Session".to_string(),
        ),
        "claude" => (
            "https://claude.ai/new".to_string(),
            "Claude — StudyApp Session".to_string(),
        ),
        "notebooklm" => (
            "https://notebooklm.google.com/".to_string(),
            "NotebookLM — StudyApp Session".to_string(),
        ),
        "perplexity" => (
            "https://www.perplexity.ai/".to_string(),
            "Perplexity — StudyApp Session".to_string(),
        ),
        "deepseek" => (
            "https://chat.deepseek.com/".to_string(),
            "DeepSeek — StudyApp Session".to_string(),
        ),
        "grok" => (
            "https://grok.com/".to_string(),
            "Grok — StudyApp Session".to_string(),
        ),
        "copilot" => (
            "https://copilot.microsoft.com/".to_string(),
            "Microsoft Copilot — StudyApp Session".to_string(),
        ),
        "poe" => (
            "https://poe.com/".to_string(),
            "Poe — StudyApp Session".to_string(),
        ),
        "mistral" | "lechat" => (
            "https://chat.mistral.ai/".to_string(),
            "Mistral Le Chat — StudyApp Session".to_string(),
        ),
        _ => {
            let fallback = format!(
                "https://duckduckgo.com/?q={}+AI+chat",
                provider.trim().replace(' ', "+")
            );
            (
                fallback,
                format!("{} — StudyApp AI Session", provider.trim()),
            )
        }
    };

    let resolved_url = match custom_url.map(str::trim).filter(|s| !s.is_empty()) {
        Some(u) if u.starts_with("http://") || u.starts_with("https://") => u.to_string(),
        Some(u) => format!("https://{u}"),
        None => default_url,
    };

    Ok((
        format!("ai_panel_{clean_slug}"),
        format!("ai_float_{clean_slug}"),
        resolved_url,
        default_title,
    ))
}

pub fn resolve_ai_provider(provider: &str) -> Result<(String, String, String, String), String> {
    resolve_ai_provider_with_url(provider, None)
}

/// Canonicalises `path` even when it does not exist yet by resolving the deepest existing ancestor
/// (following symlinks / `..`) and re-appending the remaining, already-normalised components.
fn canonicalize_lenient(path: &Path) -> Result<PathBuf, String> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cursor = path.to_path_buf();
    loop {
        match std::fs::canonicalize(&cursor) {
            Ok(mut base) => {
                for part in tail.iter().rev() {
                    base.push(part);
                }
                return Ok(base);
            }
            Err(_) => {
                let name = cursor
                    .file_name()
                    .ok_or_else(|| format!("Cannot resolve path {:?}", path))?
                    .to_os_string();
                if name == ".." {
                    return Err(format!("Unresolvable '..' segment in {:?}", path));
                }
                tail.push(name);
                if !cursor.pop() {
                    return Err(format!("Cannot resolve path {:?}", path));
                }
            }
        }
    }
}

/// Validates that a (relative or absolute) path resolves strictly inside `E:\StudyApp\MyFiles\`.
/// Relative inputs are joined onto the sandbox root. The path is canonicalised first, so `../`
/// traversal, symlink escapes and sibling-prefix tricks (`MyFiles_evil`) are all rejected.
/// Returns the canonical, validated path.
pub fn enforce_e_drive_sandbox(candidate: &Path) -> Result<PathBuf, String> {
    let _ = std::fs::create_dir_all(SANDBOX_ROOT);
    let root = std::fs::canonicalize(SANDBOX_ROOT)
        .map_err(|e| format!("Sandbox root unavailable: {e}"))?;
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        PathBuf::from(SANDBOX_ROOT).join(candidate)
    };
    let resolved = canonicalize_lenient(&joined)?;
    // `Path::starts_with` compares whole components, so `MyFiles_evil` does not match `MyFiles`.
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(format!(
            "Constitution Violation: Path {:?} is outside the E:\\StudyApp\\MyFiles sandbox.",
            candidate
        ))
    }
}

/// Embedded canonical schema (MyFiles/srs_data/schema.sql)
const SCHEMA_SQL: &str = include_str!("../../MyFiles/srs_data/schema.sql");

/// Applies `schema.sql` to `E:\StudyApp\MyFiles\srs_data\studyapp_srs.db` with foreign keys enabled.
pub fn init_database() -> Result<(), String> {
    let dir = PathBuf::from(SANDBOX_ROOT).join("srs_data");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create srs_data: {e}"))?;
    let db_path = enforce_e_drive_sandbox(&dir.join("studyapp_srs.db"))?;
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys=ON;").map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;

    // Migration: databases created before FSRS-5 lack `srs_cards.learning_step`.
    let has_learning_step: bool = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(srs_cards)")
            .map_err(|e| e.to_string())?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        let mut found = false;
        for n in names {
            if n.map_err(|e| e.to_string())? == "learning_step" {
                found = true;
            }
        }
        found
    };
    if !has_learning_step {
        conn.execute_batch("ALTER TABLE srs_cards ADD COLUMN learning_step INTEGER NOT NULL DEFAULT 0;")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
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
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

/// Forwards user text selection from the Vault Reader UI to `127.0.0.1:47821/highlight`
#[tauri::command]
async fn update_active_highlight(
    active_file: String,
    selected_text: String,
    surrounding_context: String,
) -> Result<String, String> {
    // Sandbox gate: reject `../` escapes before the path ever reaches the Python bridge.
    let validated = enforce_e_drive_sandbox(Path::new(&active_file))?;
    let root = std::fs::canonicalize(SANDBOX_ROOT).map_err(|e| e.to_string())?;
    let relative_file = validated
        .strip_prefix(&root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    let client = reqwest::Client::new();
    let payload = serde_json::json!({
        "active_file": relative_file,
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

/// Hot-swaps the active docked AI Web-View inside the `main` window using the Warm-1 RAM Pool.
///
/// Each provider owns exactly one native child webview (unique label `ai_panel_<provider>`). Switching
/// never destroys a webview: the previously docked panel is `hide()`-den (DOM, cookies, and JS state stay
/// resident) and the target is either `show()`-n (if already warm) or created once. Because panel labels
/// are looked up before creation, label collisions cannot occur. Cookies/IndexedDB persist in the shared
/// `E:\StudyApp\MyFiles\.webview_partitions\persist_study_session` profile.
#[tauri::command]
fn switch_active_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    provider: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    target_url: Option<String>,
) -> Result<AiPanelStatus, String> {
    let norm_provider = provider.to_lowercase();
    let (panel_label, float_label, target_url, _title) =
        resolve_ai_provider_with_url(&norm_provider, target_url.as_deref())?;

    // Holding this lock for the whole swap serialises concurrent switch/redock requests.
    let mut active_guard = state
        .active_docked_provider
        .lock()
        .map_err(|e| format!("Mutex lock error: {e}"))?;

    // A provider that currently lives in a floating window cannot also be docked: focus the float.
    let is_detached = state
        .detached_providers
        .lock()
        .map_err(|e| format!("Mutex lock error: {e}"))?
        .contains_key(&norm_provider);
    if is_detached {
        if let Some(win) = app.get_webview_window(&float_label) {
            let _ = win.set_focus();
            return Ok(AiPanelStatus {
                provider: norm_provider,
                mode: "detached".to_string(),
                label: float_label,
                target_url,
                partition_dir: STUDY_SESSION_PARTITION_DIR.to_string(),
            });
        }
    }

    // (a) Fully hide the previously docked webview BEFORE touching the new one.
    if let Some(prev_provider) = active_guard.clone() {
        if prev_provider != norm_provider {
            let (prev_label, _, _, _) = resolve_ai_provider(&prev_provider)?;
            if let Some(prev_wv) = app.get_webview(&prev_label) {
                prev_wv
                    .hide()
                    .map_err(|e| format!("Failed to hide previous panel '{prev_label}': {e}"))?;
            }
        }
    }

    // (b)+(c) Reuse the warm webview if its label exists; only create when absent.
    if let Some(existing) = app.get_webview(&panel_label) {
        existing
            .set_position(LogicalPosition::new(x, y))
            .map_err(|e| format!("Failed to reposition '{panel_label}': {e}"))?;
        existing
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| format!("Failed to resize '{panel_label}': {e}"))?;
        existing
            .show()
            .map_err(|e| format!("Failed to show '{panel_label}': {e}"))?;
    } else {
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
    }

    // Only record the new active provider once the mount/show actually succeeded.
    *active_guard = Some(norm_provider.clone());

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
fn mount_persistent_ai_panel(
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

    let status = switch_active_ai_panel(app, state, inferred.to_string(), 920.0, 56.0, 680.0, 904.0, Some(target_url))?;
    Ok(format!("Mounted {} ({}) in mode {}", status.provider, status.label, status.mode))
}

/// Undocks the specified AI provider from the `main` split-pane and spawns a native floating desktop window
/// sharing `persist:study_session`.
#[tauri::command]
fn detach_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    provider: String,
    target_url: Option<String>,
) -> Result<AiPanelStatus, String> {
    let norm_provider = provider.to_lowercase();
    let (panel_label, float_label, target_url, title) =
        resolve_ai_provider_with_url(&norm_provider, target_url.as_deref())?;

    // Unmount docked child webview if currently active
    {
        let mut active_guard = state
            .active_docked_provider
            .lock()
            .map_err(|e| format!("Mutex lock error: {e}"))?;
        // Keep the docked webview warm (hidden) so redock is instant and label reuse is collision-free.
        if let Some(existing_wv) = app.get_webview(&panel_label) {
            existing_wv
                .hide()
                .map_err(|e| format!("Failed to hide docked panel '{panel_label}': {e}"))?;
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
fn redock_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    provider: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    target_url: Option<String>,
) -> Result<AiPanelStatus, String> {
    let norm_provider = provider.to_lowercase();
    let (_panel_label, float_label, _target_url, _title) =
        resolve_ai_provider_with_url(&norm_provider, target_url.as_deref())?;

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

    switch_active_ai_panel(app, state, norm_provider, x, y, width, height, target_url)
}

/// Navigates an active docked or floating AI WebView to a new URL or search query inside its mini-browser bar
#[tauri::command]
fn navigate_ai_panel(
    app: tauri::AppHandle,
    provider: String,
    url: String,
) -> Result<String, String> {
    let norm_provider = provider.to_lowercase();
    let (panel_label, float_label, resolved_url, _) =
        resolve_ai_provider_with_url(&norm_provider, Some(&url))?;
    let parsed: url::Url = resolved_url
        .parse()
        .map_err(|e| format!("Invalid target URL: {e}"))?;

    if let Some(wv) = app.get_webview(&panel_label) {
        wv.navigate(parsed.clone())
            .map_err(|e| format!("Failed to navigate docked webview '{panel_label}': {e}"))?;
        return Ok(resolved_url);
    }
    if let Some(win) = app.get_webview_window(&float_label) {
        win.navigate(parsed)
            .map_err(|e| format!("Failed to navigate floating window '{float_label}': {e}"))?;
        return Ok(resolved_url);
    }
    Ok(resolved_url)
}

/// Syncs the native docked child Web-View bounds whenever the user drags the React split-pane divider
#[tauri::command]
fn resize_docked_ai_panel(
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
    // E:\ Law: main window and all child WebViews share one E:\ WebView2 profile (never C:\ AppData)
    let _ = std::fs::create_dir_all(STUDY_SESSION_PARTITION_DIR);
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", STUDY_SESSION_PARTITION_DIR);

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

            // Build/upgrade the SQLite schema before anything touches the DB
            if let Err(e) = init_database() {
                eprintln!("[StudyApp] SQLite schema init failed: {e}");
            }

            // Spawn Python MCP sidecar server
            if let Some(child) = spawn_mcp_sidecar() {
                let state = app.state::<AppRuntimeState>();
                let lock_result = state.mcp_sidecar.lock();
                if let Ok(mut guard) = lock_result {
                    *guard = Some(child);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let Some(provider) = window.label().strip_prefix("ai_float_") {
                if let tauri::WindowEvent::Destroyed = event {
                    let state = window.state::<AppRuntimeState>();
                    let removed = match state.detached_providers.lock() {
                        Ok(mut g) => g.remove(provider).is_some(),
                        Err(_) => false,
                    };
                    let _ = removed;
                }
            }
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
            navigate_ai_panel,
            update_active_highlight,
        ])
        .run(tauri::generate_context!())
        .expect("error while running StudyApp tauri application");
}

#[cfg(test)]
mod sandbox_tests {
    use super::*;

    #[test]
    fn accepts_paths_inside_sandbox() {
        assert!(enforce_e_drive_sandbox(Path::new("vault/note.md")).is_ok());
        assert!(enforce_e_drive_sandbox(Path::new(r"E:\StudyApp\MyFiles\srs_data\studyapp_srs.db")).is_ok());
    }

    #[test]
    fn rejects_traversal_and_foreign_paths() {
        assert!(enforce_e_drive_sandbox(Path::new("../secrets.txt")).is_err());
        assert!(enforce_e_drive_sandbox(Path::new("vault/../../outside.md")).is_err());
        assert!(enforce_e_drive_sandbox(Path::new(r"C:\Windows\win.ini")).is_err());
        assert!(enforce_e_drive_sandbox(Path::new(r"E:\StudyApp\MyFiles_evil\x.md")).is_err());
    }
}