export interface SrsCard {
  id: string;
  deckSystem: string;
  cardType: "mcq" | "written" | "cloze";
  frontPrompt: string;
  markScheme: string;
  mcqOptionsJson?: string;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  reps: number;
  lapses: number;
  state: number;
  dueDate: string;
  lastReview?: string;
}

export interface ColabGradeResponse {
  grade: 1 | 2 | 3 | 4 | 5;
  physiologicalFeedback: string;
  missingConcepts: string[];
}

export interface MindMapEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  linkingPhrase: string; // Max ~20-30 words
  crossSystemBridge: boolean;
}
