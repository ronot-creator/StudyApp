# Constitution.md
**Project:** Local-First Medical AI Study Pipeline
**Author/Manager:** User, Gemini (Primary Architect). No other model may alter this document unless explicitly instructed.
**Last Updated:** October 2026

## 1. Application Overview
This application is an autonomous, local-first medical intelligence pipeline. It is built as a lightweight **Tauri desktop shell** (chosen over Electron for a smaller footprint, lower memory usage, and native OS webview integration). It utilizes a multi-panel web-view interface to house persistent authenticated AI sessions, a local Model Context Protocol (MCP) server, and a cloud-based compute-arbitrage micro-fleet. It is designed specifically to test medical reasoning via contextually tolerant Spaced Repetition (SRS) rather than rote memorization.

## 2. Model Delegation & Asset Sourcing
*   **Heavy Lifting & Ingestion (Gemini 4 Argon / Pro):** 
    *   Runs inside a persistent authenticated web-view panel (using `persist:study_session`).
    *   **Duties:** PDF ingestion, OCR, advanced Markdown structuring, generating 2nd/3rd-order clinical bridging questions, and **extracting anatomical/histological images directly from the ingested textbooks**.
*   **External Image Sourcing (Dedicated Micro-Model/Agent):**
    *   **Duties:** Outsourcing and downloading supplementary real-world medical imagery (e.g., actual gross bone specimens, specific histology slides) from credited external databases to supplement the textbook images.
*   **Micro-Tasks (Colab Pro CPU Fleet):**
    *   Runs 24/7 via an Ngrok tunnel to the local app.
    *   **Models:** 1.5B - 3B parameter models (e.g., Qwen 2.5 3B, Llama 3.2 3B).
    *   **Duties:** Contextual grading of written answers (evaluating physiological understanding and forgiving exact phrasing), keyword extraction for mind maps, and background UI tagging.

## 3. Local Storage Sandbox
All data remains entirely local in a flat Markdown structure to guarantee portability, offline access, and fast search.
*   **Hardware Limit:** The application is restricted to the **E:\ partition** (0.5 TB / 500 GB HDD capacity). All operations must respect this constraint.
*   **Root Directory:** `E:\StudyApp\MyFiles\`
*   **Sub-directories:**
    *   `/vault/`: Contains all processed `.md` lecture notes.
    *   `/images/`: Contains all medical imagery (both textbook extracts and outsourced assets). Files are named descriptively based on anatomical/structural content.
    *   `/srs_data/`: SQLite database handling the FSRS scheduling and card metadata.

## 3.5 GitHub Version Control
*   **Repository Name:** `StudyApp` (Capital S, Capital A, no spaces).
*   **Function:** Serves as the remote origin for the project's source code, initialized and modified via Gemini 4 Argon Task Mode using the Composio GitHub MCP connector.
*   **Syncing:** The remote `StudyApp` repository maps directly to the local `E:\StudyApp` base directory. All local-first coding workflows, Tauri boilerplate, and Python MCP server scripts are version-controlled here. *(Note: Large medical PDFs and downloaded local images inside the `MyFiles/` directory must be added to `.gitignore` to preserve repository speed and avoid data bloat).*

## 4. The Spaced Repetition System (SRS) Workflow
The SRS module tests applied knowledge.
*   **MCQs:** Evaluated instantly via strict UI logic. 
*   **Written / Fill-in-the-Gaps:**
    1. User types an explanation.
    2. User clicks "Check Answer(s)".
    3. The app pings the Colab 3B model via Ngrok with the User's Answer and the Mark Scheme.
    4. **Tolerance Logic:** The model evaluates semantic correctness and physiological understanding, forgiving exact wording.
    5. The model returns a JSON grade (1-5) and brief feedback.
    6. FSRS algorithm schedules the next interval automatically based on the grade.

## 5. Mind Map Implementation
Mind maps are strictly structural flowcharts.
*   **Modularity:** Maps are generated per-system (e.g., Renal, Cardiovascular) but support cross-system bridging.
*   **Linking:** Extracted from Markdown syntax or right-click UI actions.
*   **Phrases:** Edges (arrows) between nodes support short linking phrases (e.g., `[Male Urethra] --(passes through)--> [Prostate Gland]`). Maximum ~20-30 words.

## 6. MCP Tool Schemas (The Local Bridge)
The local Python MCP server exposes the following capabilities:
*   `list_my_files(directory)`: Returns array of available local `.md` and image files.
*   `read_file(filename)`: Pipes local file text directly into the model's context window.
*   `write_markdown(filename, content)`: Saves processed textbook chunks or generated SRS cards directly to the E:\ drive.
*   `get_active_highlight()`: Returns the text currently selected by the user in the UI, plus surrounding context.
*   `save_thought_anchor(anchor_id, explanation)`: Writes a customized AI margin-note back into the active Markdown file.

## 7. Prime Directives
1. **Zero API Spend:** Never use the API for tasks that can be done via the persistent web-view or the Colab micro-fleet.
2. **Context over Rote:** Flashcards must test medical reasoning and bridging concepts.
3. **Persisted Auth:** Google account sign-ins (Gemini, NotebookLM) must utilize browser partition persistence to survive app restarts.
