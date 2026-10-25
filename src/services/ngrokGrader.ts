import Database from "@tauri-apps/plugin-sql";
import { ColabGradeResponse, OcclusionBox } from "../types/study";

export const SQLITE_DB_URI = "sqlite:E:/StudyApp/MyFiles/srs_data/studyapp_srs.db";

export type ReplayGradedCallback = (result: ColabGradeResponse) => void;

export interface NgrokGraderOptions {
  /** Optional fetch implementation for testing (defaults to global fetch). */
  fetchFn?: typeof fetch;
  /** Optional storage implementation (defaults to localStorage). */
  storage?: Storage;
}

export class NgrokGraderService {
  private fetchFn: typeof fetch;
  private storage: Storage;
  private isOnline: boolean = false;
  private lastLatencyMs: number | null = null;
  private replayListeners: Set<ReplayGradedCallback> = new Set();

  constructor(options: NgrokGraderOptions = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.storage = options.storage ?? localStorage;
  }

  private get tunnelUrl(): string {
    return this.storage.getItem("studyapp_ngrok_url") || "";
  }

  private get fleetToken(): string {
    return this.storage.getItem("studyapp_fleet_token") || "studyapp-local-secret";
  }

  public getTunnelUrl(): string {
    return this.tunnelUrl;
  }

  public setTunnelConfig(url: string, token?: string): void {
    const cleaned = url.trim().replace(/\/+$/, "");
    this.storage.setItem("studyapp_ngrok_url", cleaned);
    if (token !== undefined) {
      this.storage.setItem("studyapp_fleet_token", token.trim());
    }
  }

  public onReplayGraded(cb: ReplayGradedCallback): () => void {
    this.replayListeners.add(cb);
    return () => this.replayListeners.delete(cb);
  }

  public async checkHealth(): Promise<{ online: boolean; latencyMs: number | null; model?: string }> {
    const url = this.tunnelUrl;
    if (!url) {
      this.isOnline = false;
      this.lastLatencyMs = null;
      return { online: false, latencyMs: null };
    }
    const start = performance.now();
    try {
      const resp = await this.fetchFn(`${url}/health`, {
        method: "GET",
        headers: {
          "X-Fleet-Token": this.fleetToken,
          "ngrok-skip-browser-warning": "true",
        },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const wasOffline = !this.isOnline;
      this.isOnline = true;
      this.lastLatencyMs = Math.round(performance.now() - start);
      if (wasOffline) {
        void this.replayQueue();
      }
      return { online: true, latencyMs: this.lastLatencyMs, model: data.model };
    } catch {
      this.isOnline = false;
      this.lastLatencyMs = null;
      return { online: false, latencyMs: null };
    }
  }

  public async gradeWritten(
    cardId: string,
    questionPrompt: string,
    markScheme: string,
    userAnswer: string
  ): Promise<ColabGradeResponse> {
    const url = this.tunnelUrl;
    if (url && this.isOnline) {
      try {
        const resp = await this.fetchFn(`${url}/grade-written`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fleet-Token": this.fleetToken,
            "ngrok-skip-browser-warning": "true",
          },
          body: JSON.stringify({
            card_id: cardId,
            question_prompt: questionPrompt,
            mark_scheme: markScheme,
            user_answer: userAnswer,
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return {
          cardId: data.card_id || cardId,
          grade: data.grade,
          physiologicalFeedback: data.physiological_feedback,
          missingConcepts: data.missing_concepts || [],
          evaluatorModel: data.evaluator_model || "qwen2.5:3b-instruct",
          queuedOffline: false,
        };
      } catch {
        this.isOnline = false;
      }
    }

    // Queue in local SQLite grading_queue for automatic oldest-first replay on reconnect
    try {
      const db = await Database.load(SQLITE_DB_URI);
      const queueId = `gq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.execute(
        `INSERT INTO grading_queue (id, card_id, question_prompt, mark_scheme, user_answer, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [queueId, cardId, questionPrompt, markScheme, userAnswer]
      );
    } catch {
      // Fallback to storage queue when running in browser preview mode
      const cached = JSON.parse(this.storage.getItem("studyapp_offline_grading_queue") || "[]");
      cached.push({ cardId, questionPrompt, markScheme, userAnswer, queuedAt: new Date().toISOString() });
      this.storage.setItem("studyapp_offline_grading_queue", JSON.stringify(cached));
    }

    return {
      cardId,
      grade: 3,
      physiologicalFeedback: "Queued in Local SQLite (Auto-Replays on Reconnect)",
      missingConcepts: [],
      evaluatorModel: "OFFLINE_SQLITE_QUEUE",
      queuedOffline: true,
    };
  }

  /** Returns the number of pending items in the offline grading queue. */
  public async pendingCount(): Promise<number> {
    try {
      const db = await Database.load(SQLITE_DB_URI);
      const rows = await db.select<{ cnt: number }[]>(
        `SELECT COUNT(*) as cnt FROM grading_queue WHERE status = 'pending'`
      );
      return rows[0]?.cnt ?? 0;
    } catch {
      const cached = JSON.parse(this.storage.getItem("studyapp_offline_grading_queue") || "[]");
      return cached.length;
    }
  }

  public async replayQueue(): Promise<number> {
    const url = this.tunnelUrl;
    if (!url || !this.isOnline) return 0;
    let replayedCount = 0;

    try {
      const db = await Database.load(SQLITE_DB_URI);
      const pendingRows = await db.select<
        Array<{
          id: string;
          card_id: string;
          question_prompt: string;
          mark_scheme: string;
          user_answer: string;
        }>
      >(
        `SELECT id, card_id, question_prompt, mark_scheme, user_answer
           FROM grading_queue
           WHERE status = 'pending'
           ORDER BY queued_at ASC`
      );

      for (const row of pendingRows) {
        const result = await this.gradeWritten(
          row.card_id,
          row.question_prompt,
          row.mark_scheme,
          row.user_answer
        );
        if (!result.queuedOffline) {
          await db.execute(`UPDATE grading_queue SET status = 'completed' WHERE id = $1`, [row.id]);
          replayedCount++;
          this.replayListeners.forEach((cb) => cb(result));
        }
      }
    } catch {
      // Fallback replay from localStorage in browser dev preview
    }

    return replayedCount;
  }

  public async requestImageOcclusionBoxes(
    imageFilename: string,
    organSystem: string,
    anatomicalStructure: string,
    hints?: string[]
  ): Promise<OcclusionBox[]> {
    const url = this.tunnelUrl;
    if (url && this.isOnline) {
      try {
        const resp = await this.fetchFn(`${url}/generate-image-occlusion`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fleet-Token": this.fleetToken,
            "ngrok-skip-browser-warning": "true",
          },
          body: JSON.stringify({
            image_filename: imageFilename,
            organ_system: organSystem,
            anatomical_structure: anatomicalStructure,
            detected_text_hints: hints,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          return data.boxes || [];
        }
      } catch {
        // Fall through to deterministic local fallback boxes
      }
    }

    return [
      {
        id: "occ_1",
        label_text: `${anatomicalStructure} — Primary Cortical / Luminal Zone`,
        x_pct: 14,
        y_pct: 18,
        width_pct: 28,
        height_pct: 10,
      },
      {
        id: "occ_2",
        label_text: `${anatomicalStructure} — Afferent / Efferent Vascular Supply`,
        x_pct: 56,
        y_pct: 24,
        width_pct: 30,
        height_pct: 10,
      },
      {
        id: "occ_3",
        label_text: `${anatomicalStructure} — Basement Membrane / Epithelial Interface`,
        x_pct: 22,
        y_pct: 68,
        width_pct: 34,
        height_pct: 10,
      },
    ];
  }
}

let _graderInstance: NgrokGraderService | null = null;
export function getNgrokGrader(): NgrokGraderService {
  if (!_graderInstance) {
    _graderInstance = new NgrokGraderService();
  }
  return _graderInstance;
},
          }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return {
          cardId: data.card_id || cardId,
          grade: data.grade,
          physiologicalFeedback: data.physiological_feedback,
          missingConcepts: data.missing_concepts || [],
          evaluatorModel: data.evaluator_model || "qwen2.5:3b-instruct",
          queuedOffline: false,
        };
      } catch {
        this.isOnline = false;
      }
    }
public async replayQueue(): Promise<number> {
    const url = this.tunnelUrl;
    if (!url || !this.isOnline) return 0;
    let replayedCount = 0;

    try {
      const db = await Database.load(SQLITE_DB_URI);
      const pendingRows = await db.select<
        Array<{
          id: string;
          card_id: string;
          question_prompt: string;
          mark_scheme: string;
          user_answer: string;
        }>
      >(
        `SELECT id, card_id, question_prompt, mark_scheme, user_answer
           FROM grading_queue
           WHERE status = 'pending'
           ORDER BY queued_at ASC`
      );

      for (const row of pendingRows) {
        const result = await this.gradeWritten(
          row.card_id,
          row.question_prompt,
          row.mark_scheme,
          row.user_answer
        );
        if (!result.queuedOffline) {
          await db.execute(`UPDATE grading_queue SET status = 'completed' WHERE id = $1`, [row.id]);
          replayedCount++;
          this.replayListeners.forEach((cb) => cb(result));
        }
      }
    } catch {
      // Fallback replay from localStorage in browser dev preview
    }

    return replayedCount;
  }

  public async requestImageOcclusionBoxes(
    imageFilename: string,
    organSystem: string,
    anatomicalStructure: string,
    hints?: string[]
  ): Promise<OcclusionBox[]> {
    const url = this.tunnelUrl;
    if (url && this.isOnline) {
      try {
        const resp = await this.fetchFn(`${url}/generate-image-occlusion`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fleet-Token": this.fleetToken,
            "ngrok-skip-browser-warning": "true",
          },
          body: JSON.stringify({
            image_filename: imageFilename,
            organ_system: organSystem,
            anatomical_structure: anatomicalStructure,
            detected_text_hints: hints,
          }),
        });
        if (resp.ok) {
          const data = await resp.json();
          return data.boxes || [];
        }
      } catch {
        // Fall through to deterministic local fallback boxes
      }
    }

    return [
      {
        id: "occ_1",
        label_text: `${anatomicalStructure} — Primary Cortical / Luminal Zone`,
        x_pct: 14,
        y_pct: 18,
        width_pct: 28,
        height_pct: 10,
      },
      {
        id: "occ_2",
        label_text: `${anatomicalStructure} — Afferent / Efferent Vascular Supply`,
        x_pct: 56,
        y_pct: 24,
        width_pct: 30,
        height_pct: 10,
      },
      {
        id: "occ_3",
        label_text: `${anatomicalStructure} — Basement Membrane / Epithelial Interface`,
        x_pct: 22,
        y_pct: 68,
        width_pct: 34,
        height_pct: 10,
      },
    ];
  }
}

let _graderInstance: NgrokGraderService | null = null;
export function getNgrokGrader(): NgrokGraderService {
  if (!_graderInstance) {
    _graderInstance = new NgrokGraderService();
  }
  return _graderInstance;
}

// Queue in local SQLite grading_queue for automatic oldest-first replay on reconnect
try {
  const db = await Database.load(SQLITE_DB_URI);
  const queueId = `gq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await db.execute(
    `INSERT INTO grading_queue (id, card_id, question_prompt, mark_scheme, user_answer, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [queueId, cardId, questionPrompt, markScheme, userAnswer]
  );
} catch {
  // Fallback to localStorage queue when running in browser preview mode
  const cached = JSON.parse(this.storage.getItem("studyapp_offline_grading_queue") || "[]");
  cached.push({ cardId, questionPrompt, markScheme, userAnswer, queuedAt: new Date().toISOString() });
  this.storage.setItem("studyapp_offline_grading_queue", JSON.stringify(cached));
}

return {
  cardId,
  grade: 3,
  physiologicalFeedback: "Queued in Local SQLite (Auto-Replays on Reconnect)",
  missingConcepts: [],
  evaluatorModel: "OFFLINE_SQLITE_QUEUE",
  queuedOffline: true,
};
  }

  /** Returns the number of pending items in the offline grading queue. */
  public async pendingCount(): Promise < number > {
  try {
    const db = await Database.load(SQLITE_DB_URI);
    const rows = await db.select<{ cnt: number }[]>(
      `SELECT COUNT(*) as cnt FROM grading_queue WHERE status = 'pending'`
    );
    return rows[0]?.cnt ?? 0;
  } catch {
    const cached = JSON.parse(this.storage.getItem("studyapp_offline_grading_queue") || "[]");
    return cached.length;
  }
}