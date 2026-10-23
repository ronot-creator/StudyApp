# 🏛️ SYSTEM CONSTITUTION: Local-First Medical AI Study Pipeline (`StudyApp`)

> **SUPREME ARCHITECTURAL DIRECTIVE FOR ALL AI AGENTS & COLLABORATORS:**
> **Project:** Autonomous Local-First Medical Intelligence & Spaced-Repetition Pipeline (`ronot-creator/StudyApp`)  
> **Primary Architect & Manager:** User, Gemini 4 Argon (Lead Solutions Architect)  
> **Last Updated:** October 2026  
> **Enforcement Level:** ABSOLUTE. No AI model, automated agent, or script may alter this document or deviate from its file paths, storage quotas, UI tokens, window-management paradigms, or model-delegation boundaries unless explicitly instructed by the User.

---

## 1. Executive Summary & Codebase Baseline

`StudyApp` is an autonomous, local-first medical intelligence desktop pipeline engineered to ingest dense medical textbooks/lectures, extract high-yield clinical concepts and anatomical imagery, construct cross-system physiological mind maps, and test deep medical reasoning via contextually tolerant **Free Spaced Repetition Scheduler (FSRS)** reviews—all operating at **$0.00 recurring API cost**.

### 1.1 Why Tauri v2 Over Electron
The desktop shell is built on **Tauri v2 (Rust)** (`src-tauri/`) paired with a **React 18 + TypeScript + Vite** frontend (`src/`). Tauri is mandated over Electron to guarantee:
1. Minimal RAM/CPU footprint alongside heavy PDF/Markdown vaults.
2. Native OS WebView2 / WebKit multi-webview orchestration (`tauri::webview::WebviewBuilder`) that bypasses browser `X-Frame-Options` restrictions without iframe hacks.
3. Strict, compile-time Rust filesystem sandboxing (`enforce_e_drive_sandbox`) bound to the `E:\` hardware partition.

### 1.2 Completed Architectural Phases (Ground-Truth Inventory)
*   **Phase 1 — Core Local Foundation (COMPLETE):**
    *   **Rust Shell (`src-tauri/src/lib.rs`):** Enforces `SANDBOX_ROOT = E:\StudyApp\MyFiles`, manages persistent WebView partitions (`STUDY_SESSION_PARTITION_DIR`), spawns and gracefully terminates the Python MCP sidecar (`McpSidecar`), and forwards live UI text selections to the local MCP bridge (`MCP_BRIDGE_PORT = 47821` on loopback `/highlight`).
    *   **Local SQLite FSRS Schema (`MyFiles/srs_data/schema.sql`):** Configured in `WAL` mode (`studyapp_srs.db`) with 7 canonical tables: `vault_documents`, `medical_images`, `srs_cards`, `srs_review_logs`, `thought_anchors`, `mindmap_nodes`, `mindmap_edges`, and `grading_queue`.
    *   **Local Python FastMCP Server (`mcp-server/src/server.py` & `sandbox.py`):** Exposes the 5 core MCP tools (`list_my_files`, `read_file`, `write_markdown`, `get_active_highlight`, `save_thought_anchor`) protected by strict path-escape resolution and `E:\` disk quota guardrails (`check_disk_quota`).
*   **Phase 2 — Cloud Compute-Arbitrage Fleet & Offline Resilience (COMPLETE):**
    *   **Colab Pro 3B Micro-Fleet (`colab-fleet/fleet_server.py`):** FastAPI service running inside Google Colab behind an Ngrok tunnel (`X-Fleet-Token` authenticated), serving 1.5B–3B parameter models (`qwen2.5:3b-instruct` / `Llama-3.2-3B-Instruct` via Ollama or vLLM) with `/health`, `/grade-written`, `/extract-mindmap-triples`, and `/auto-tag` endpoints.
    *   **Ngrok Offline Queue & Auto-Replay (`src/services/ngrokGrader.ts`):** Monitors tunnel health/latency every 15s (`TunnelStatus.tsx`), caches written answers into the local SQLite `grading_queue` table whenever the Colab tunnel drops or rotates, and replays queued answers oldest-first automatically upon reconnection.

### 1.3 Active Development Frontier (Phases 3, 4, & 5 + Liquid Glass UI Overhaul)
*   **Phase 3:** Interactive Markdown Vault Reader, live `onMouseUp` highlight piping (`update_active_highlight`), inline Thought Anchor margin-note rendering, and PDF/textbook chunk & image ingestion workflows.
*   **Phase 4:** Full FSRS v4/v5 scheduling engine wired to the UI deck reviewer (instant strict MCQ grading + asynchronous Colab 3B semantic written/fill-in-gap grading with replay hooks).
*   **Phase 5:** Interactive `@xyflow/react` Organ-System Mind Map canvas with deterministic + Colab 3B triple extraction (`[Source] --(linking phrase <= 30 words)--> [Target]`) and cross-system clinical bridges.
*   **UI/UX Overhaul:** Transforming the barebones `src/App.tsx` stub into a complete **Liquid Glass (Glassmorphism)** workspace with native docked and detachable multi-AI Web-Views (`Gemini`, `ChatGPT`, `Claude`).

---

## 2. Core Infrastructure & Storage Mandates (Non-Negotiable)

### 2.1 The `E:\` Partition Sandbox & 500GB Quota Law
1.  **Hardware Allocation:** The application is strictly confined to the **`E:\` partition** (`500 GB / 0.5 TB` allocated quota, with a mandatory `5 GB` minimum free-space reserve so OS and SQLite WAL operations never starve).
2.  **Canonical Root Path:** `E:\StudyApp\MyFiles\`
    *   **Never** substitute `E:\StudyApp_Data\` or any `C:\Users\...\AppData\` path. Every Rust command, TypeScript service, and Python MCP tool must resolve paths inside `E:\StudyApp\MyFiles\`.
3.  **Mandatory Directory Hierarchy:**
    *   `E:\StudyApp\MyFiles\vault\` — Processed `.md` lecture notes and textbook chapters.
    *   `E:\StudyApp\MyFiles\images\` — Extracted textbook figures, histology slides, radiology, and credited external gross specimens (named descriptively by anatomical structure).
    *   `E:\StudyApp\MyFiles\srs_data\studyapp_srs.db` — Primary SQLite database (accessed in frontend via `sqlite:E:/StudyApp/MyFiles/srs_data/studyapp_srs.db`).
    *   `E:\StudyApp\MyFiles\.webview_partitions\persist_study_session\` — Persistent browser session data, cookies, and IndexedDB storage for authenticated AI Web-Views.
4.  **Double-Layer Enforcement:**
    *   **Rust Layer:** Every file operation in `src-tauri/` must validate paths through `enforce_e_drive_sandbox(candidate: &PathBuf)` and obey `src-tauri/capabilities/default.json` (`fs:scope` restricted to `E:/StudyApp/MyFiles/**`).
    *   **Python MCP Layer:** Every file read/write in `mcp-server/` must pass through `resolve_sandboxed_path()` and `check_disk_quota(incoming_bytes)` (`safe_write_bytes` / `safe_write_text`).

### 2.2 Local SQLite & FSRS Data Integrity
*   **WAL Concurrency:** Connections to `E:\StudyApp\MyFiles\srs_data\studyapp_srs.db` must maintain `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;` so the Tauri frontend (`@tauri-apps/plugin-sql`) and the Python MCP server can read/write concurrently without `SQLITE_BUSY` deadlocks.
*   **Schema Preservation:** The 7 core tables in `MyFiles/srs_data/schema.sql` (`vault_documents`, `medical_images`, `srs_cards`, `srs_review_logs`, `thought_anchors`, `mindmap_nodes`, `mindmap_edges`, `grading_queue`) are canonical. Any schema extension must be additive (`CREATE TABLE IF NOT EXISTS` / reversible migration) and preserve existing FSRS columns (`stability`, `difficulty`, `elapsed_days`, `scheduled_days`, `reps`, `lapses`, `state`, `due_date`, `last_review`).

### 2.3 The Zero-API-Spend Mandate ($0.00 Token Spend)
*   **Strict Prohibition on Paid LLM APIs:** No component in `src/`, `src-tauri/`, `mcp-server/`, or `colab-fleet/` may call commercial pay-per-token endpoints (OpenAI API, Anthropic API, paid Google Gemini API keys).
*   **Approved Zero-Spend Compute Channels:**
    1.  **Authenticated Native Tauri Web-Views:** Web sessions for **Gemini**, **ChatGPT**, and **Claude** running inside `persist:study_session`.
    2.  **Colab Pro 3B Micro-Fleet:** `colab-fleet/fleet_server.py` running `qwen2.5:3b-instruct` or `Llama-3.2-3B-Instruct` over the Ngrok tunnel.
    3.  **Deterministic Local Logic:** Local regex triple parsing (`EXPLICIT_TRIPLE_RE`), local FSRS math, and strict UI MCQ evaluation.

### 2.4 GitHub Version Control (`ronot-creator/StudyApp`)
*   The remote repository `ronot-creator/StudyApp` maps directly to `E:\StudyApp`.
*   Binary medical PDFs, high-resolution images inside `MyFiles/images/`, live SQLite `.db` / `.db-wal` / `.db-shm` files, and `.webview_partitions/` must remain git-ignored (`.gitignore`), while `MyFiles/srs_data/schema.sql` and `.gitkeep` structure files are tracked.

---

## 3. Window Management & Native Web-View Architecture

### 3.1 Absolute Ban on HTML `<iframe>` Elements
*   **NO IFRAMES:** Embedding external AI web clients (Gemini, ChatGPT, Claude, NotebookLM) via HTML `<iframe>` or DOM `<webview>` tags inside React components is **strictly forbidden**. Provider security headers (`X-Frame-Options: DENY`, `frame-ancestors 'none'`, and Cross-Origin cookie restrictions) will break rendering and OAuth login sessions.

### 3.2 Native Tauri Multi-Web-View Orchestration
All AI web interfaces must be spawned and controlled natively by the Rust backend using Tauri v2's multi-webview and windowing APIs (`tauri::webview::WebviewBuilder`, `tauri::WebviewWindowBuilder`, `Window::add_child`, `Webview::set_position`, `Webview::set_size`, `Webview::hide`, `Webview::show`).

#### 1. Supported AI Providers & Panel Labels
*   **Gemini:** `panel_label: "gemini_study_panel"` (Google Gemini Web App)
*   **ChatGPT:** `panel_label: "chatgpt_study_panel"` (OpenAI ChatGPT Web App)
*   **Claude:** `panel_label: "claude_study_panel"` (Anthropic Claude Web App)
*   *(Optional Auxiliary)* **NotebookLM:** `panel_label: "notebooklm_study_panel"` (Google NotebookLM Web App)
*   **Capability Registration:** `src-tauri/capabilities/default.json` must list all AI panel labels (`"main"`, `"gemini_study_panel"`, `"chatgpt_study_panel"`, `"claude_study_panel"`, `"notebooklm_study_panel"`) under `"windows"`.

#### 2. Persistent Authentication (`persist:study_session`)
*   Every AI Web-View must bind its `.data_directory(...)` to `E:\StudyApp\MyFiles\.webview_partitions\persist_study_session` (validated by `partition_id == "persist:study_session"`).
*   This guarantees that Google, OpenAI, and Anthropic logins, session cookies, and local storage survive app restarts without re-authentication.

#### 3. Default Docked Mode (Side-by-Side Split Layout)
*   By default, the active AI Web-View is mounted as a **child Web-View docked inside the `main` Tauri window** alongside the local Markdown Vault / File Explorer / FSRS pane.
*   The local React UI occupies the left/center workspace (e.g., `0..920px` or dynamic split ratio), and the docked native Web-View is positioned flush on the right (`LogicalPosition`, `LogicalSize`) and dynamically resized on window/splitter drag events via Rust IPC (`resize_docked_ai_panel`).

#### 4. Active AI Switcher (Instant Dock Hot-Swapping)
*   The UI header/sidebar must provide a segmented **AI Provider Switcher** (`Gemini` | `ChatGPT` | `Claude`).
*   Switching providers invokes a Rust command (`switch_active_ai_panel(provider)`) that:
    1. Hides the currently visible docked child Web-View (preserving its DOM state and in-flight generation in memory).
    2. Shows (or lazily initializes and mounts) the selected provider's child Web-View in the exact docked bounds.

#### 5. Detachable Floating Desktop Windows ("Undock / Re-dock")
*   The user must be able to **detach** any AI panel from the docked split-view into its own **independent, floating OS desktop window** (and re-dock it back into `main` on demand):
    *   **`detach_ai_panel(panel_label)`:** Closes or unmounts the child Web-View from `main` and spawns an independent `WebviewWindow` (`WebviewWindowBuilder::new(&app, format!("{panel_label}_floating"), WebviewUrl::External(url)).data_directory(STUDY_SESSION_PARTITION_DIR)`) with native OS window decorations, resize handles, and optional `always_on_top` toggle, while reclaiming 100% of the `main` window width for the local Vault/Mind-Map canvas.
    *   **`redock_ai_panel(panel_label)`:** Closes the floating window and seamlessly re-mounts the provider into the `main` window's right-hand dock, sharing the exact same `persist:study_session` profile directory so session state is never lost.

---

## 4. UI/UX Aesthetic Mandate: The "Liquid Glass" Design System

The barebones inline styles in `src/` must be replaced with a cohesive, high-craft **Liquid Glass (Glassmorphism)** design system optimized for deep medical focus, low eye strain, and spatial hierarchy.

### 4.1 Core Visual Principles
1.  **Translucent Layered Depth:** Every sidebar, navigation rail, card container, inspector drawer, and floating toolbar must be a semi-transparent glass surface layered over a deep atmospheric radial/mesh background (`#060b16` -> `#0f172a` -> `#0b1f2e`).
2.  **Mandatory Backdrop Blur:** All elevated panels must apply hardware-accelerated backdrop blur (`backdrop-filter: blur(...) saturate(...)` and `-webkit-backdrop-filter: blur(...) saturate(...)`).
3.  **Specular 1px Borders:** Panels must use subtle translucent white/cyan borders (`1px solid rgba(255, 255, 255, 0.12)`) with brighter top-edge specular highlights (`rgba(255, 255, 255, 0.22)`) to create crisp physical glass edges.
4.  **Ban on Flat Opaque Surfaces:** Raw opaque hex backgrounds (`#000`, `#fff`, flat `#1e293b` without alpha/blur) and unstyled browser controls (`<button>`, `<input>`, `<hr>`) are prohibited in `src/`.

### 4.2 Canonical CSS Design Tokens (`src/styles/liquid-glass.css`)
All frontend components must consume these standardized CSS custom properties:

```css
:root {
  /* Atmospheric Canvas */
  --canvas-bg-gradient: radial-gradient(circle at 15% 15%, #0f2942 0%, #091326 45%, #050a14 100%);

  /* Liquid Glass Surfaces */
  --glass-surface-base: rgba(15, 23, 42, 0.52);
  --glass-surface-elevated: rgba(30, 41, 59, 0.62);
  --glass-surface-interactive: rgba(56, 189, 248, 0.10);
  --glass-surface-active: rgba(56, 189, 248, 0.18);
  --glass-surface-input: rgba(9, 15, 29, 0.68);

  /* Optical Blur & Refraction */
  --glass-blur-sm: blur(10px) saturate(160%);
  --glass-blur-md: blur(18px) saturate(180%);
  --glass-blur-lg: blur(28px) saturate(200%);

  /* Specular Borders & Shadows */
  --glass-border-subtle: 1px solid rgba(255, 255, 255, 0.10);
  --glass-border-specular: 1px solid rgba(255, 255, 255, 0.22);
  --glass-border-accent: 1px solid rgba(56, 189, 248, 0.45);
  --glass-shadow-ambient: 0 12px 40px -8px rgba(0, 0, 0, 0.55), inset 0 1px 0 0 rgba(255, 255, 255, 0.14);

  /* Typography & Clinical Telemetry Accents */
  --text-primary: #f8fafc;
  --text-secondary: #cbd5e1;
  --text-muted: #64748b;
  --accent-cyan: #38bdf8;
  --accent-emerald: #22c55e;
  --accent-amber: #f59e0b;
  --accent-rose: #ef4444;

  /* Radii & Motion */
  --radius-sm: 8px;
  --radius-md: 14px;
  --radius-lg: 20px;
  --transition-spring: 220ms cubic-bezier(0.22, 1, 0.36, 1);
}
```

---

## 5. Model Delegation Protocol (The Waterfall Strategy)

Because development operates under strict frontier-model quota constraints, all engineering tasks across the `StudyApp` lifecycle must follow **The Waterfall Strategy**:

### Tier 1 — Heavy Architecture & Core Structural Phases
*   **Assigned Models:** **Claude 5.5 Sonnet** & **Gemini 4 Argon (Primary)**
*   **Exclusive Mandate:**
    *   Completing the remaining structural phases (**Phase 3: Vault & Thought Anchors**, **Phase 4: Tolerant FSRS Engine**, **Phase 5: Cross-System Mind Map Engine**).
    *   Writing and refactoring all **Rust/Tauri backend logic** (`src-tauri/src/`), multi-webview docking/detaching controllers, capability manifests, and concurrency/process management.
    *   Designing complex SQLite FSRS transactions, Python FastMCP server extensions (`mcp-server/`), and Colab FastAPI fleet protocols (`colab-fleet/`).
*   **Quota Protection Rule:** Tier 1 models must **never** be spent on repetitive CSS tweaking, minor UI copy edits, or trivial linting fixes.

### Tier 2 — UI/UX Iteration & Liquid Glass Implementation
*   **Assigned Model:** **Gemini 4 Argon (Secondary)**
*   **Exclusive Mandate:**
    *   Activated once core backend phases and IPC signatures are locked.
    *   Executing the full frontend transformation in `src/` using the **Liquid Glass** design system (`backdrop-filter: blur`, translucent panels, specular borders, smooth split-pane resizers, and interactive React Flow / FSRS views).
    *   Wiring React state cleanly to the Rust IPC commands and `NgrokGrader` service.

### Tier 3 — Daily Operations, Debugging & Maintenance
*   **Assigned Model:** **Gemini 3.8 Flash**
*   **Exclusive Mandate:**
    *   Activated for daily operational coding, maintenance, and rapid iteration once Tier 1 / Tier 2 heavy quotas are conserved or exhausted.
    *   Handling unit test additions (`tests/`, `mcp-server/tests/`, `colab-fleet/tests/`), small UI polish tweaks, TypeScript/Rust compiler warning fixes, and documentation upkeep.
*   **Strict Boundary:** Gemini 3.8 Flash is **forbidden** from altering `Constitution.md`, modifying `MyFiles/srs_data/schema.sql`, or re-architecting `src-tauri/` window/sandbox internals without explicit human authorization.

### 5.1 Auxiliary Runtime Compute Delegation (Pipeline Operation)
During live study sessions inside the app (distinct from codebase engineering above):
*   **Heavy Ingestion & Asset Extraction (Docked Web-Views — Gemini / Claude / ChatGPT):** PDF/lecture ingestion, 2nd/3rd-order clinical bridging question creation, and anatomical/histological textbook image extraction.
*   **External Medical Imagery Sourcing (Dedicated Micro-Agent):** Sourcing credited gross bone specimens, histology slides, and radiology images into `E:\StudyApp\MyFiles\images\`.
*   **24/7 Micro-Tasks (Colab Pro CPU/GPU 3B Fleet via Ngrok):** Semantic physiological grading of written FSRS answers (`/grade-written`), mind-map triple extraction (`/extract-mindmap-triples`), and organ-system auto-tagging (`/auto-tag`).

---

## 6. Domain Subsystem Specifications (Phases 3–5 Blueprint)

### 6.1 Spaced Repetition System (FSRS) & Tolerant Grading Workflow
1.  **Clinical Bridging Focus:** Cards in `srs_cards` target 2nd- and 3rd-order physiological mechanisms (`question_order IN (2, 3)`) rather than isolated 1st-order rote recall.
2.  **MCQ Evaluation:** Evaluated instantaneously in the local UI against `mcq_options_json` and `mcq_correct_index` (`evaluator_model = 'UI_STRICT_MCQ'`).
3.  **Written / Fill-in-the-Gap Evaluation:**
    *   User submits a physiological explanation in the FSRS Review UI.
    *   `NgrokGrader.gradeWritten(cardId, req)` posts `{question_prompt, mark_scheme, user_answer}` to the Colab 3B fleet (`/grade-written`).
    *   **Tolerance Rubric:** The 3B model forgives wording, synonyms, abbreviations, and sentence order, grading purely on physiological accuracy and causal mechanisms (`grade` 1–5, `physiological_feedback`, `missing_concepts[]`).
    *   **Offline Fallback:** If the Ngrok tunnel is offline (`TunnelUnavailableError`), the submission is stored in `grading_queue` (`status = 'pending'`) and automatically graded and FSRS-scheduled via `onReplayGraded` as soon as `startMonitor` detects tunnel recovery.

### 6.2 Organ-System Mind Maps & Cross-System Bridging
*   **Canonical Organ Systems:** `Renal`, `Cardiovascular`, `Respiratory`, `Gastrointestinal`, `Neurological`, `Endocrine`, `Musculoskeletal`, `Reproductive`, `Hematological`, `Immunological`, `Integumentary`, `Lymphatic`.
*   **Linking Phrase Constraint:** Every directed edge in `mindmap_edges` (`@xyflow/react`) must carry a concise physiological verb phrase of **at most 20–30 words** (`<= 240 chars` in SQLite; `MAX_LINK_WORDS = 30` in `fleet_server.py`), e.g., `[Male Urethra] --(passes through)--> [Prostate Gland]`.
*   **Dual Extraction Pipeline:**
    1.  Deterministic Markdown regex (`[Source] --(linking phrase)--> [Target]`).
    2.  Colab 3B prose extraction (`POST /extract-mindmap-triples`).
*   **Cross-System Bridges:** Edges connecting nodes from two different organ systems set `is_cross_system_bridge = 1` and render with distinct high-contrast telemetry styling in the mind-map canvas.

### 6.3 Local Python MCP Server Contract (`mcp-server/src/server.py`)
The local FastMCP server (`StudyApp-Local-Bridge`) exposes exactly 5 canonical tools to connected AI agents, backed by the loopback highlight bridge (`MCP_BRIDGE_PORT = 47821`):
1.  `list_my_files(directory: str = "vault")` -> Lists `.md` and image assets inside `E:\StudyApp\MyFiles\{vault|images|srs_data}`.
2.  `read_file(filename: str)` -> Safely reads UTF-8 Markdown content from `E:\StudyApp\MyFiles\`.
3.  `write_markdown(filename: str, content: str, organ_system: str = "General")` -> Quota-checked write to `E:\StudyApp\MyFiles\vault\` + automatic upsert into `vault_documents` (with SHA-256 checksum).
4.  `get_active_highlight()` -> Returns `{active_file, selected_text, surrounding_context}` pushed from the Tauri UI via `update_active_highlight`.
5.  `save_thought_anchor(anchor_id: str, explanation: str)` -> Persists an AI margin note into `thought_anchors` and injects an inline `<!-- thought-anchor:{anchor_id} -->` callout block into the active Markdown file.

---

## 7. Pre-Commit Verification Checklist for AI Agents

Before any AI agent commits code or proposes a pull request to `ronot-creator/StudyApp`, it **must** verify every item below:

- [ ] **Sandbox Compliance:** Do all file/DB paths strictly resolve inside `E:\StudyApp\MyFiles\` (`sqlite:E:/StudyApp/MyFiles/srs_data/studyapp_srs.db`) with zero `C:\` leakage?
- [ ] **Zero-API-Spend Compliance:** Are there zero paid commercial LLM API calls or paid SDK dependencies introduced?
- [ ] **No-Iframe Compliance:** Are all external AI tools (`Gemini`, `ChatGPT`, `Claude`) rendered exclusively via native Tauri Web-Views (`WebviewBuilder` / `WebviewWindowBuilder`) using `persist:study_session` with docked switching + floating window detach support?
- [ ] **Liquid Glass Compliance:** Does all frontend UI code in `src/` use the Liquid Glass CSS token system (`backdrop-filter: blur`, semi-transparent surfaces, 1px specular borders) with zero raw unstyled HTML stubs?
- [ ] **Waterfall Model Compliance:** Is the executing AI model operating strictly within its assigned tier (Tier 1: Claude 5.5 Sonnet / Gemini 4 Argon for Phases 3–5 & Rust; Tier 2: Gemini 4 Argon for Liquid Glass UI; Tier 3: Gemini 3.8 Flash for maintenance & small tweaks)?
