-- ============================================================================
-- StudyApp Canonical 8-Table WAL SQLite Schema
-- Location: E:\StudyApp\MyFiles\srs_data\studyapp_srs.db
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vault_documents (
    id TEXT PRIMARY KEY,
    organ_system TEXT NOT NULL,
    relative_path TEXT NOT NULL UNIQUE,
    source_textbook TEXT,
    checksum_sha256 TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS medical_images (
    id TEXT PRIMARY KEY,
    descriptive_filename TEXT NOT NULL UNIQUE,
    organ_system TEXT NOT NULL,
    anatomical_structure TEXT NOT NULL,
    modality TEXT NOT NULL CHECK (modality IN ('textbook_extract', 'gross_specimen', 'histology_slide', 'radiology', 'diagram', 'pathway', 'model_3d')),
    source_credit TEXT NOT NULL,
    source_url TEXT,
    occlusion_boxes_json TEXT DEFAULT '[]',
    associated_document_id TEXT REFERENCES vault_documents(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS srs_cards (
    id TEXT PRIMARY KEY,
    document_id TEXT REFERENCES vault_documents(id) ON DELETE CASCADE,
    organ_system TEXT NOT NULL,
    card_type TEXT NOT NULL CHECK (card_type IN ('mcq', 'written', 'fill_in_gap', 'image_occlusion')),
    question_order INTEGER NOT NULL DEFAULT 2 CHECK (question_order IN (1, 2, 3)),
    front_prompt TEXT NOT NULL,
    mark_scheme TEXT NOT NULL,
    mcq_options_json TEXT,
    mcq_correct_index INTEGER,
    image_id TEXT REFERENCES medical_images(id) ON DELETE SET NULL,
    occlusion_Boxes_json TEXT,
    stability REAL NOT NULL DEFAULT 0.0,
    difficulty REAL NOT NULL DEFAULT 5.0,
    elapsed_days INTEGER NOT NULL DEFAULT 0,
    scheduled_days INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    state INTEGER NOT NULL DEFAULT 0 CHECK (state IN (0, 1, 2, 3)),
    due_date TEXT NOT NULL DEFAULT (datetime('now')),
    last_review TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_srs_cards_due ON srs_cards(due_date, state);
CREATE INDEX IF NOT EXISTS idx_srs_cards_system ON srs_cards(organ_system);

CREATE TABLE IF NOT EXISTS srs_review_logs (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES srs_cards(id) ON DELETE CASCADE,
    user_written_answer TEXT,
    grade INTEGER NOT NULL CHECK (grade BETWEEN 1 AND 5),
    evaluator_model TEXT NOT NULL,
    ai_feedback TEXT,
    review_duration_ms INTEGER,
    stability_before REAL,
    stability_after REAL,
    difficulty_before REAL,
    difficulty_after REAL,
    reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS thought_anchors (
    anchor_id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
    highlighted_excerpt TEXT NOT NULL,
    ai_explanation TEXT NOT NULL,
    block_offset INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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
    linking_phrase TEXT NOT NULL CHECK (length(linking_phrase) <= 240),
    is_cross_system_bridge INTEGER NOT NULL DEFAULT 0 CHECK (is_cross_system_bridge IN (0, 1)),
    target_organ_system TEXT
);

CREATE TABLE IF NOT EXISTS grading_queue (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES srs_cards(id) ON DELETE CASCADE,
    question_prompt TEXT NOT NULL,
    mark_scheme TEXT NOT NULL,
    user_answer TEXT NOT NULL,
    queued_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    retry_count INTEGER NOT NULL DEFAULT 0
);
