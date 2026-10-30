use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    LogicalPosition, LogicalSize, Manager, State, WebviewBuilder, WebviewUrl, WebviewWindowBuilder,
};

/// Localhost MCP Sidecar port (bound on startup via `Command::new_sidecar("mcp-sidecar")`)
pub const MCP_SIDECAR_PORT: u16 = 1420;
/// Localhost HTTP highlight bridge endpoint in mcp-server
pub const HIGHLIGHT_BRIDGE_URL: &str = "http://127.0.0.1:47821/highlight";

/// WebView2 RAM Diet & Lag Optimization flags applied before Tauri boots
pub const WEBVIEW2_RAM_DIET_ARGS: &str =
    "--process-per-site --enable-features=msWebView2BrowserHitTransparent --js-flags=--max-old-space-size=512";

/// Lightweight MutationObserver injected into AI WebViews to auto-click "Allow" on Composio MCP tool prompts
/// and disable heavy background CSS animations to conserve GPU/RAM.
/// Embedded Preload Command Bridge (`src-tauri/src/preload.js`) injected into all AI WebViews
pub const PRELOAD_BRIDGE_SCRIPT: &str = include_str!("preload.js");

pub const AUTO_ALLOW_AND_PERF_SCRIPT: &str = r#"
(function() {
  if (window.__CONVERGENCE_MCP_OBSERVER_INSTALLED__) return;
  window.__CONVERGENCE_MCP_OBSERVER_INSTALLED__ = true;

  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after {
      scroll-behavior: auto !important;
    }
  `;
  document.documentElement.appendChild(style);

  const clickAllowIfNeeded = () => {
    const buttons = document.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      const txt = (btn.textContent || '').trim();
      if (txt === 'Allow' || txt === 'Always Allow' || txt === 'Allow tool') {
        const containerText = (btn.closest('div, section, form')?.textContent || '');
        if (
          containerText.includes('Composio') ||
          containerText.includes('MCP') ||
          containerText.includes('Convergence') ||
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

/// Extension trait providing Tauri sidecar resolution (`Command::new_sidecar("mcp-sidecar")`)
pub trait SidecarCommandExt {
    fn new_sidecar(name: &str) -> Result<Command, String>;
}

impl SidecarCommandExt for Command {
    fn new_sidecar(name: &str) -> Result<Command, String> {
        let clean = name.trim_start_matches("bin/").trim_start_matches("bin\\");
        let target_triple = if cfg!(target_os = "windows") {
            "x86_64-pc-windows-msvc.exe"
        } else if cfg!(target_os = "macos") {
            "aarch64-apple-darwin"
        } else {
            "x86_64-unknown-linux-gnu"
        };
        let sidecar_filename = format!("{clean}-{target_triple}");

        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_dir) = exe_path.parent() {
                candidates.push(exe_dir.join(&sidecar_filename));
                candidates.push(exe_dir.join("bin").join(&sidecar_filename));
                candidates.push(exe_dir.join(if cfg!(target_os = "windows") {
                    format!("{clean}.exe")
                } else {
                    clean.to_string()
                }));
            }
        }
        candidates.push(PathBuf::from("src-tauri/bin").join(&sidecar_filename));
        candidates.push(PathBuf::from("bin").join(&sidecar_filename));

        for candidate in candidates {
            if candidate.exists() {
                return Ok(Command::new(candidate));
            }
        }
        Ok(Command::new(sidecar_filename))
    }
}

/// Resolves the dynamic OS `$APPLOCALDATA` root directory for Convergence.
/// Uses Tauri v2's `app.path().app_local_data_dir()` when an `AppHandle` is provided,
/// or resolves via OS environment variables (`CONVERGENCE_APPDATA_DIR` / `LOCALAPPDATA` / `XDG_DATA_HOME`).
pub fn resolve_app_local_data_dir(app: Option<&tauri::AppHandle>) -> PathBuf {
    if let Some(handle) = app {
        if let Ok(dir) = handle.path().app_local_data_dir() {
            return dir;
        }
    }
    if let Ok(custom) = std::env::var("CONVERGENCE_APPDATA_DIR")
        .or_else(|_| std::env::var("STUDYAPP_APPDATA_DIR"))
    {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        if !local_appdata.trim().is_empty() {
            return PathBuf::from(local_appdata).join("com.convergence.studyapp");
        }
    }
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.trim().is_empty() {
            return PathBuf::from(xdg).join("com.convergence.studyapp");
        }
    }
    if let Ok(home) = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")) {
        if !home.trim().is_empty() {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("com.convergence.studyapp");
        }
    }
    std::env::temp_dir().join("com.convergence.studyapp")
}

/// Resolves the persistent WebView profile directory inside `$APPLOCALDATA/.webview_partitions/persist_study_session`.
pub fn sanitize_ai_slug(raw: &str) -> String {
    let slug: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if slug.is_empty() { "custom".to_string() } else { slug }
}

pub fn resolve_ai_provider_partition_dir(
    app: Option<&tauri::AppHandle>,
    provider_slug: &str,
) -> (String, PathBuf) {
    let clean_slug = sanitize_ai_slug(provider_slug);
    let partition_id = format!("persist:ai_{clean_slug}");
    let dir = resolve_app_local_data_dir(app)
        .join(".webview_partitions")
        .join(format!("persist_ai_{clean_slug}"));
    (partition_id, dir)
}

pub fn resolve_study_session_partition_dir(app: Option<&tauri::AppHandle>) -> PathBuf {
    resolve_app_local_data_dir(app)
        .join(".webview_partitions")
        .join("persist_study_session")
}

/// Automatically creates `vault`, `images`, `srs_data`, and `.webview_partitions/persist_study_session`
/// inside `$APPLOCALDATA` on startup if they are missing.
pub fn ensure_appdata_subdirs(base_dir: &Path) -> Result<(), String> {
    for sub in [
        "vault",
        "images",
        "raw_assets",
        "srs_data",
        "tesseract_langs",
        ".webview_partitions/persist_study_session",
    ] {
        let dir = base_dir.join(sub);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create AppLocalData subdir {:?}: {e}", dir))?;
    }
    Ok(())
}

/// Tracks the bundled MCP Sidecar process, resolved `$APPLOCALDATA` root, and Warm-1 Active Docked AI WebView state
pub struct AppRuntimeState {
    pub mcp_sidecar: Mutex<Option<Child>>,
    pub active_docked_provider: Mutex<Option<String>>,
    pub detached_providers: Mutex<HashMap<String, String>>,
    pub app_data_dir: Mutex<PathBuf>,
}

impl Default for AppRuntimeState {
    fn default() -> Self {
        Self {
            mcp_sidecar: Mutex::new(None),
            active_docked_provider: Mutex::new(None),
            detached_providers: Mutex::new(HashMap::new()),
            app_data_dir: Mutex::new(resolve_app_local_data_dir(None)),
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
            "Gemini 4 Argon — Convergence Session".to_string(),
        ),
        "chatgpt" => (
            "https://chatgpt.com/".to_string(),
            "ChatGPT — Convergence Session".to_string(),
        ),
        "claude" => (
            "https://claude.ai/new".to_string(),
            "Claude — Convergence Session".to_string(),
        ),
        "notebooklm" => (
            "https://notebooklm.google.com/".to_string(),
            "NotebookLM — Convergence Session".to_string(),
        ),
        "perplexity" => (
            "https://www.perplexity.ai/".to_string(),
            "Perplexity — Convergence Session".to_string(),
        ),
        "deepseek" => (
            "https://chat.deepseek.com/".to_string(),
            "DeepSeek — Convergence Session".to_string(),
        ),
        "grok" => (
            "https://grok.com/".to_string(),
            "Grok — Convergence Session".to_string(),
        ),
        "copilot" => (
            "https://copilot.microsoft.com/".to_string(),
            "Microsoft Copilot — Convergence Session".to_string(),
        ),
        "poe" => (
            "https://poe.com/".to_string(),
            "Poe — Convergence Session".to_string(),
        ),
        "mistral" | "lechat" => (
            "https://chat.mistral.ai/".to_string(),
            "Mistral Le Chat — Convergence Session".to_string(),
        ),
        _ => {
            let fallback = format!(
                "https://duckduckgo.com/?q={}+AI+chat",
                provider.trim().replace(' ', "+")
            );
            (
                fallback,
                format!("{} — Convergence AI Session", provider.trim()),
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

/// Validates that a (relative or absolute) path resolves strictly inside the dynamic `$APPLOCALDATA` sandbox.
pub fn enforce_appdata_sandbox_with_root(base_dir: &Path, candidate: &Path) -> Result<PathBuf, String> {
    let _ = std::fs::create_dir_all(base_dir);
    let root = std::fs::canonicalize(base_dir)
        .map_err(|e| format!("AppLocalData sandbox root unavailable: {e}"))?;
    let joined = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        base_dir.join(candidate)
    };
    let resolved = canonicalize_lenient(&joined)?;
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(format!(
            "Convergence Sandbox Violation: Path {:?} escapes AppLocalData sandbox {:?}",
            candidate, root
        ))
    }
}

pub fn enforce_appdata_sandbox(candidate: &Path) -> Result<PathBuf, String> {
    let base = resolve_app_local_data_dir(None);
    enforce_appdata_sandbox_with_root(&base, candidate)
}

/// Embedded canonical schema (MyFiles/srs_data/schema.sql)
const SCHEMA_SQL: &str = include_str!("../../MyFiles/srs_data/schema.sql");

/// Applies `schema.sql` to `$APPLOCALDATA/srs_data/studyapp_srs.db` with foreign keys enabled.
pub fn init_database_at(base_dir: &Path) -> Result<PathBuf, String> {
    ensure_appdata_subdirs(base_dir)?;
    let dir = base_dir.join("srs_data");
    let schema_file = dir.join("schema.sql");
    if !schema_file.exists() {
        let _ = std::fs::write(&schema_file, SCHEMA_SQL);
    }
    let db_path = enforce_appdata_sandbox_with_root(base_dir, &dir.join("studyapp_srs.db"))?;
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA foreign_keys=ON;").map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA_SQL).map_err(|e| e.to_string())?;

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
    Ok(db_path)
}

pub fn init_database() -> Result<(), String> {
    let base = resolve_app_local_data_dir(None);
    init_database_at(&base).map(|_| ())
}

/// Spawns the bundled `mcp-sidecar` binary on startup using `Command::new_sidecar("mcp-sidecar")` bound to port 1420.
fn spawn_mcp_sidecar(app_data_dir: &Path) -> Option<Child> {
    if let Ok(mut cmd) = Command::new_sidecar("mcp-sidecar") {
        cmd.args(["--sidecar", "--port", &MCP_SIDECAR_PORT.to_string()])
            .env("CONVERGENCE_APPDATA_DIR", app_data_dir)
            .env("STUDYAPP_APPDATA_DIR", app_data_dir)
            .env("MCP_SIDECAR_PORT", MCP_SIDECAR_PORT.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Ok(child) = cmd.spawn() {
            return Some(child);
        }
    }

    // Development fallback if running unbundled from source checkout
    let dev_server = PathBuf::from("mcp-server/src/server.py");
    if dev_server.exists() {
        return Command::new("python3")
            .args(["-m", "src.server", "--sidecar", "--port", &MCP_SIDECAR_PORT.to_string()])
            .current_dir("mcp-server")
            .env("CONVERGENCE_APPDATA_DIR", app_data_dir)
            .env("STUDYAPP_APPDATA_DIR", app_data_dir)
            .env("MCP_SIDECAR_PORT", MCP_SIDECAR_PORT.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .ok();
    }
    None
}

#[tauri::command]
fn resolve_shorthand_query(
    app: tauri::AppHandle,
    query: String,
) -> Result<serde_json::Value, String> {
    let app_data_dir = resolve_app_local_data_dir(Some(&app));
    let _ = ensure_appdata_subdirs(&app_data_dir);
    let vault_dir = app_data_dir.join("vault");
    let cleaned_topic = query
        .trim()
        .trim_start_matches("/q ")
        .trim_start_matches("/vault ")
        .trim_start_matches("/context ")
        .trim();
    let mut matched_files: Vec<String> = Vec::new();
    let mut excerpts: Vec<String> = Vec::new();
    let lower_topic = cleaned_topic.to_lowercase();

    if let Ok(entries) = std::fs::read_dir(&vault_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md") {
                let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("note.md").to_string();
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if lower_topic.is_empty()
                        || fname.to_lowercase().contains(&lower_topic)
                        || content.to_lowercase().contains(&lower_topic)
                    {
                        matched_files.push(fname.clone());
                        let snippet: String = content.chars().take(900).collect();
                        excerpts.push(format!("--- {} ---\n{}", fname, snippet.trim()));
                    }
                }
            }
        }
    }

    let context_excerpt = if excerpts.is_empty() {
        format!("No exact file match in $APPLOCALDATA/vault for '{}'. Synthesize high-yield causal mechanisms.", cleaned_topic)
    } else {
        excerpts.join("\n\n")
    };

    let formatted_prompt = format!(
        "[CONVERGENCE LOCAL VAULT CONTEXT — query: \"{}\"]\n{}\n[/CONVERGENCE LOCAL VAULT CONTEXT]\nInstruction: Using the local vault context above, provide a token-optimized, mechanistically rigorous explanation for: {}",
        cleaned_topic, context_excerpt, cleaned_topic
    );

    Ok(serde_json::json!({
        "query": cleaned_topic,
        "matched_files": matched_files,
        "context_excerpt": context_excerpt,
        "formatted_prompt": formatted_prompt,
    }))
}

#[tauri::command]
fn spawn_custom_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    name: String,
    url: String,
) -> Result<AiPanelStatus, String> {
    let clean_slug = sanitize_ai_slug(&name);
    let (_panel_label, float_label, resolved_url, _default_title) =
        resolve_ai_provider_with_url(&clean_slug, Some(&url))?;
    let (partition_id, partition_dir) = resolve_ai_provider_partition_dir(Some(&app), &clean_slug);

    std::fs::create_dir_all(&partition_dir)
        .map_err(|e| format!("Failed to create isolated AI partition '{partition_id}': {e}"))?;

    if let Some(existing_win) = app.get_webview_window(&float_label) {
        let _ = existing_win.set_focus();
    } else {
        let parsed_url: url::Url = resolved_url
            .parse()
            .map_err(|e| format!("Invalid custom AI URL '{resolved_url}': {e}"))?;

        let window_title = format!("{} ({})", name.trim(), partition_id);
        WebviewWindowBuilder::new(&app, &float_label, WebviewUrl::External(parsed_url))
            .title(&window_title)
            .inner_size(1020.0, 860.0)
            .resizable(true)
            .data_directory(partition_dir.clone())
            .initialization_script(PRELOAD_BRIDGE_SCRIPT)
            .build()
            .map_err(|e| format!("Failed to spawn custom AI WebView '{float_label}': {e}"))?;
    }

    {
        let mut detached_guard = state
            .detached_providers
            .lock()
            .map_err(|e| format!("Mutex lock error: {e}"))?;
        detached_guard.insert(clean_slug.clone(), float_label.clone());
    }

    Ok(AiPanelStatus {
        provider: clean_slug,
        mode: "detached".to_string(),
        label: float_label,
        target_url: resolved_url,
        partition_dir: partition_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn get_storage_config(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let standard = resolve_standard_os_appdata_dir(Some(&app));
    let active = resolve_app_local_data_dir(Some(&app));
    let cfg_path = standard.join(STORAGE_CONFIG_FILENAME);
    let has_custom = read_custom_drive_from_bootstrap(&standard).is_some();
    Ok(serde_json::json!({
        "config_file": cfg_path.to_string_lossy(),
        "standard_appdata_dir": standard.to_string_lossy(),
        "custom_target_dir": active.to_string_lossy(),
        "first_run_completed": has_custom,
    }))
}

#[tauri::command]
fn set_custom_storage_dir(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    target_dir: String,
) -> Result<serde_json::Value, String> {
    let standard = resolve_standard_os_appdata_dir(Some(&app));
    std::fs::create_dir_all(&standard).map_err(|e| e.to_string())?;
    let cfg_path = standard.join(STORAGE_CONFIG_FILENAME);
    let payload = serde_json::json!({
        "version": "1.0",
        "customTargetDir": target_dir.trim(),
        "firstRunCompleted": true,
    });
    let serialized = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    if serialized.len() > MAX_STORAGE_CONFIG_BYTES {
        return Err("Storage config exceeds 1KB limit".to_string());
    }
    std::fs::write(&cfg_path, serialized.as_bytes()).map_err(|e| e.to_string())?;

    let resolved = resolve_app_local_data_dir(Some(&app));
    ensure_appdata_subdirs(&resolved)?;
    if let Ok(mut guard) = state.app_data_dir.lock() {
        *guard = resolved.clone();
    }
    Ok(serde_json::json!({
        "status": "updated",
        "custom_target_dir": resolved.to_string_lossy(),
    }))
}

#[tauri::command]
fn append_webview_footnote(
    app: tauri::AppHandle,
    selected_text: String,
    source_url: Option<String>,
) -> Result<String, String> {
    let base_dir = resolve_app_local_data_dir(Some(&app));
    ensure_appdata_subdirs(&base_dir)?;
    let note_path = base_dir.join("vault").join("Renal.md");
    let existing = std::fs::read_to_string(&note_path).unwrap_or_default();
    let footnote_line = format!(
        "

[^webview]: {} (Source: {})
",
        selected_text.trim(),
        source_url.unwrap_or_else(|| "external-webview".to_string())
    );
    let updated = format!("{}{}", existing.trim_end(), footnote_line);
    std::fs::write(&note_path, updated.as_bytes()).map_err(|e| e.to_string())?;
    Ok("appended".to_string())
}

#[tauri::command]
fn get_mcp_sidecar_status(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
) -> Result<serde_json::Value, String> {
    let app_data_dir = resolve_app_local_data_dir(Some(&app));
    let running = state
        .mcp_sidecar
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);
    Ok(serde_json::json!({
        "sidecar": "bin/mcp-sidecar",
        "running": running,
        "port": MCP_SIDECAR_PORT,
        "mcp_url": format!("http://localhost:{}/mcp", MCP_SIDECAR_PORT),
        "highlight_bridge_url": HIGHLIGHT_BRIDGE_URL,
        "app_local_data_dir": app_data_dir.to_string_lossy(),
    }))
}

#[tauri::command]
async fn update_active_highlight(
    app: tauri::AppHandle,
    active_file: String,
    selected_text: String,
    surrounding_context: String,
) -> Result<String, String> {
    let base_dir = resolve_app_local_data_dir(Some(&app));
    let validated = enforce_appdata_sandbox_with_root(&base_dir, Path::new(&active_file))?;
    let root = std::fs::canonicalize(&base_dir).map_err(|e| e.to_string())?;
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
    let partition_dir = resolve_study_session_partition_dir(Some(&app));

    let mut active_guard = state
        .active_docked_provider
        .lock()
        .map_err(|e| format!("Mutex lock error: {e}"))?;

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
                partition_dir: partition_dir.to_string_lossy().to_string(),
            });
        }
    }

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
        std::fs::create_dir_all(&partition_dir)
            .map_err(|e| format!("Failed to create persist_study_session directory: {e}"))?;

        let main_window = app
            .get_window("main")
            .ok_or_else(|| "Main window 'main' not found".to_string())?;

        let parsed_url: url::Url = target_url
            .parse()
            .map_err(|e| format!("Invalid provider URL: {e}"))?;

        let webview_builder = WebviewBuilder::new(&panel_label, WebviewUrl::External(parsed_url))
            .data_directory(partition_dir.clone())
            .initialization_script(PRELOAD_BRIDGE_SCRIPT)
            .auto_resize();

        main_window
            .add_child(
                webview_builder,
                LogicalPosition::new(x, y),
                LogicalSize::new(width, height),
            )
            .map_err(|e| format!("Failed to mount docked AI webview '{panel_label}': {e}"))?;
    }

    *active_guard = Some(norm_provider.clone());

    Ok(AiPanelStatus {
        provider: norm_provider,
        mode: "docked".to_string(),
        label: panel_label,
        target_url,
        partition_dir: partition_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn mount_persistent_ai_panel(
    app: tauri::AppHandle,
    state: State<'_, AppRuntimeState>,
    panel_label: String,
    target_url: String,
    partition_id: String,
) -> Result<String, String> {
    if partition_id != "persist:study_session" {
        return Err("Convergence requires partition_id = 'persist:study_session'".into());
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

    let status = switch_active_ai_panel(
        app,
        state,
        inferred.to_string(),
        920.0,
        56.0,
        680.0,
        904.0,
        Some(target_url),
    )?;
    Ok(format!("Mounted {} ({}) in mode {}", status.provider, status.label, status.mode))
}

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
    let partition_dir = resolve_study_session_partition_dir(Some(&app));

    {
        let mut active_guard = state
            .active_docked_provider
            .lock()
            .map_err(|e| format!("Mutex lock error: {e}"))?;
        if let Some(existing_wv) = app.get_webview(&panel_label) {
            existing_wv
                .hide()
                .map_err(|e| format!("Failed to hide docked panel '{panel_label}': {e}"))?;
        }
        if active_guard.as_deref() == Some(norm_provider.as_str()) {
            *active_guard = None;
        }
    }

    std::fs::create_dir_all(&partition_dir)
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
            .data_directory(partition_dir.clone())
            .initialization_script(PRELOAD_BRIDGE_SCRIPT)
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
        partition_dir: partition_dir.to_string_lossy().to_string(),
    })
}

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
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", WEBVIEW2_RAM_DIET_ARGS);
    let bootstrap_partition = resolve_study_session_partition_dir(None);
    let _ = std::fs::create_dir_all(&bootstrap_partition);
    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &bootstrap_partition);

    tauri::Builder::default()
        .manage(AppRuntimeState::default())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .setup(|app| {
            let app_data_dir = resolve_app_local_data_dir(Some(app.handle()));
            let _ = ensure_appdata_subdirs(&app_data_dir);

            {
                let state = app.state::<AppRuntimeState>();
                if let Ok(mut dir_guard) = state.app_data_dir.lock() {
                    *dir_guard = app_data_dir.clone();
                }
            }

            if let Err(e) = init_database_at(&app_data_dir) {
                eprintln!("[Convergence] SQLite schema init failed: {e}");
            }

            if let Some(child) = spawn_mcp_sidecar(&app_data_dir) {
                let state = app.state::<AppRuntimeState>();
                if let Ok(mut guard) = state.mcp_sidecar.lock() {
                    *guard = Some(child);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let Some(provider) = window.label().strip_prefix("ai_float_") {
                if let tauri::WindowEvent::Destroyed = event {
                    let state = window.state::<AppRuntimeState>();
                    let _ = state.detached_providers.lock().map(|mut g| g.remove(provider));
                }
            }
            if window.label() == "main" {
                if let tauri::WindowEvent::Destroyed = event {
                    let state = window.state::<AppRuntimeState>();
                    if let Ok(mut guard) = state.mcp_sidecar.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
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
            get_mcp_sidecar_status,
            resolve_shorthand_query,
            spawn_custom_ai_panel,
            get_storage_config,
            set_custom_storage_dir,
            append_webview_footnote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Convergence tauri application");
}

#[cfg(test)]
mod sandbox_tests {
    use super::*;

    #[test]
    fn accepts_paths_inside_appdata_sandbox() {
        let base = resolve_app_local_data_dir(None);
        let _ = ensure_appdata_subdirs(&base);
        assert!(enforce_appdata_sandbox_with_root(&base, Path::new("vault/note.md")).is_ok());
        assert!(enforce_appdata_sandbox_with_root(&base, &base.join("srs_data/studyapp_srs.db")).is_ok());
    }

    #[test]
    fn rejects_traversal_and_foreign_paths() {
        let base = resolve_app_local_data_dir(None);
        let _ = ensure_appdata_subdirs(&base);
        assert!(enforce_appdata_sandbox_with_root(&base, Path::new("../secrets.txt")).is_err());
        assert!(enforce_appdata_sandbox_with_root(&base, Path::new("vault/../../outside.md")).is_err());
    }
}
