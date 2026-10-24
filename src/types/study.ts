export type OrganSystem =
  | "Renal"
  | "Cardiovascular"
  | "Respiratory"
  | "Gastrointestinal"
  | "Neurology"
  | "Endocrine"
  | "Musculoskeletal"
  | "Reproductive"
  | "Hematology/Oncology"
  | "Immunology"
  | "Integumentary"
  | "Multisystem/General";

export const CANONICAL_ORGAN_SYSTEMS: OrganSystem[] = [
  "Renal",
  "Cardiovascular",
  "Respiratory",
  "Gastrointestinal",
  "Neurology",
  "Endocrine",
  "Musculoskeletal",
  "Reproductive",
  "Hematology/Oncology",
  "Immunology",
  "Integumentary",
  "Multisystem/General",
];

export type AiProviderId = "gemini" | "chatgpt" | "claude" | "notebooklm";

export interface OcclusionBox {
  id: string;
  label_text: string;
  x_pct: number;
  y_pct: number;
  width_pct: number;
  height_pct: number;
}

export interface SrsCard {
  id: string;
  documentId?: string;
  organSystem: OrganSystem;
  cardType: "mcq" | "written" | "fill_in_gap" | "image_occlusion";
  questionOrder: 1 | 2 | 3;
  frontPrompt: string;
  markScheme: string;
  mcqOptionsJson?: string;
  mcqCorrectIndex?: number;
  imageId?: string;
  imagePath?: string;
  occlusionBoxesJson?: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: 0 | 1 | 2 | 3; // 0=New, 1=Learning, 2=Review, 3=Relearning
  dueDate: string;
  lastReview?: string;
}

export interface ColabGradeResponse {
  cardId: string;
  grade: 1 | 2 | 3 | 4 | 5;
  physiologicalFeedback: string;
  missingConcepts: string[];
  evaluatorModel: string;
  queuedOffline?: boolean;
}

export interface MindMapNodeRecord {
  id: string;
  organ_system: OrganSystem;
  label: string;
  source_document_id?: string;
  position_x: number;
  position_y: number;
}

export interface MindMapEdgeRecord {
  id: string;
  source_node_id: string;
  target_node_id: string;
  linking_phrase: string; // Max ~20-30 words (<= 240 chars)
  is_cross_system_bridge: 0 | 1;
  target_organ_system?: OrganSystem;
}
