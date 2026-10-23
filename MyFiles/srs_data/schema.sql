-- ============================================================================
-- StudyApp Local SQLite Schema (E:\StudyApp\MyFiles\srs_data\studyapp_srs.db)
-- Implements FSRS v4/v5 Scheduling, Tolerant Colab 3B Grading Logs,
-- Thought Anchors, and Modular Organ-System Mind Maps (Constitution Sections 4-6)
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 1. Lecture Notes & Textbook Ingestion Registry
CREATE TABLE IF NOT EXISTS vault_documents (
    id TEXT PRIMARY KEY,
    organ_system TEXT NOT NULL,           -- e.g., 'Renal', 'Cardiovascular', 'Respiratory'
    relative_path TEXT NOT NULL UNIQUE,   -- Relative to E:\StudyApp\MyFiles\vault\
    source_textbook TEXT,
    checksum_sha256 TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Medical Imagery Assets (Textbook Extracts + Credited External Specimens)
CREATE TABLE IF NOT EXISTS medical_images (
    id TEXT PRIMARY KEY,
    descriptive_filename TEXT NOT NULL UNIQUE, -- Stored in E:\StudyApp\MyFiles\images\
    organ_system TEXT NOT NULL,
    anatomical_structure TEXT NOT NULL,
    modality TEXT NOT NULL CHECK (modality IN ('textbook_extract', 'gross_specimen', 'histology_slide', 'radiology', 'diagram')),
    source_credit TEXT NOT NULL,               -- Textbook citation or external database attribution
    associated_document_id TEXT REFERENCES vault_documents(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. Spaced Repetition Cards (FSRS Scheduling State + Clinical Bridging Metadata)
CREATE TABLE IF NOT EXISTS srs_cards (
    id TEXT PRIMARY KEY,
    document_id TEXT REFERENCES vault_documents(id) ON DELETE CASCADE,
    organ_system TEXT NOT NULL,
    card_type TEXT NOT NULL CHECK (card_type IN ('mcq', 'written', 'fill_in_gap')),
    question_order INTEGER NOT NULL DEFAULT 2 CHECK (question_order IN (1, 2, 3)), -- 2nd/3rd-order clinical bridging
    front_prompt TEXT NOT NULL,
    mark_scheme TEXT NOT NULL,                 -- Physiological explanation rubric for Colab 3B semantic grading
    mcq_options_json TEXT,                     -- JSON array for instant strict UI evaluation when card_type = 'mcq'
    mcq_correct_index INTEGER,
    image_id TEXT REFERENCES medical_images(id) ON DELETE SET NULL,
    -- FSRS Core Memory State Parameters
    stability REAL NOT NULL DEFAULT 0.0,
    difficulty REAL NOT NULL DEFAULT 5.0,
    elapsed_days INTEGER NOT NULL DEFAULT 0,
    scheduled_days INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    state INTEGER NOT NULL DEFAULT 0 CHECK (state IN (0, 1, 2, 3)), -- 0=New, 1=Learning, 2=Review, 3=Relearning
    due_date TEXT NOT NULL DEFAULT (datetime('now')),
    last_review TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_srs_cards_due ON srs_cards(due_date, state);
CREATE INDEX IF NOT EXISTS idx_srs_cards_system ON srs_cards(organ_system);

-- 4. Contextually Tolerant Review & Colab 3B Grading Logs
CREATE TABLE IF NOT EXISTS srs_review_logs (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES srs_cards(id) ON DELETE CASCADE,
    user_written_answer TEXT,
    grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 5), -- 1-5 scale returned by Colab 3B or MCQ evaluator
    evaluator_model TEXT NOT NULL,                        -- e.g., 'UI_STRICT_MCQ', 'Qwen-2.5-3B-Colab', 'Llama-3.2-3B-Colab'
    ai_feedback TEXT,
    review_duration_ms INTEGER,
    stability_before REAL,
    stability_after REAL,
    difficulty_before REAL,
    difficulty_after REAL,
    reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 5. Thought Anchors (AI Margin Notes linked to Markdown Vault files)
CREATE TABLE IF NOT EXISTS thought_anchors (
    anchor_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
    highlighted_excerpt TEXT NOT NULL,
    ai_explanation TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 6. Modular Mind Map Nodes & Cross-System Bridging Edges
CREATE TABLE IF NOT EXISTS mindmap_nodes (
    id TEXT PRIMARY KEY,
    organ_system TEXT NOT NULL,
    label TEXT NOT NULL,
    source_document_id TEXT REFERENCES vault_documents(id) ON DELETE SET NULL,
    position_x REAL NOT NULL DEFAULT 0.0,
    position_y REAL NOT NULL DEFAULT 0.0
);

CREATE TABLE IF NOT EXISTS mindmap_edges (
    id TEXT PRIMARY KEY,
    source_node_id TEXT NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
    target_node_id TEXT NOT NULL REFERENCES mindmap_nodes(id) ON DELETE CASCADE,
    linking_phrase TEXT NOT NULL CHECK (length(linking_phrase) <= 240), -- Short linking phrase (~20-30 words max)
    is_cross_system_bridge INTEGER NOT NULL DEFAULT 0 CHECK (is_cross_system_bridge IN (0, 1))
);

-- 7. Offline Grading Queue (written answers cached while the Ngrok tunnel is down; replayed on reconnect)
CREATE TABLE IF NOT EXISTS grading_queue (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    question_prompt TEXT NOT NULL,
    mark_scheme TEXT NOT NULL,
    user_answer TEXT NOT NULL,
    enqueued_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','graded','failed')),
    result_json TEXT,
    graded_at TEXT
);
