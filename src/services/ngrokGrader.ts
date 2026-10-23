/**
 * Ngrok tunnel client for the Colab 3B micro-fleet (Constitution Sections 2 & 4).
 *
 * - Verifies tunnel health + latency.
 * - If the tunnel drops or rotates, ungraded written answers are cached in the local
 *   SQLite `grading_queue` table and replayed (in order) once the tunnel is back.
 *
 * All I/O is injected (db / fetch / storage / clock) so the logic is unit-testable.
 */
import type { ColabGradeResponse } from "../types/study";

export const SRS_DB_URL = "sqlite:E:/StudyApp/MyFiles/srs_data/studyapp_srs.db";
const STORAGE_KEY = "studyapp.ngrok";
const HEALTH_TIMEOUT_MS = 5_000;
const GRADE_TIMEOUT_MS = 90_000; // 3B model on Colab CPU can be slow
const MAX_REPLAY_ATTEMPTS = 8;

export interface DbLike {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
  select<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface GradeRequest {
  questionPrompt: string;
  markScheme: string;
  userAnswer: string;
}

export interface TunnelHealth {
  online: boolean;
  latencyMs: number | null;
  checkedAt: number;
  error?: string;
}

export type GradeOutcome =
  | { status: "graded"; result: ColabGradeResponse }
  | { status: "queued"; queueId: string };

export interface QueueRow {
  id: string;
  card_id: string;
  question_prompt: string;
  mark_scheme: string;
  user_answer: string;
  enqueued_at: string;
  attempts: number;
  last_error: string | null;
  status: "pending" | "graded" | "failed";
  result_json: string | null;
  graded_at: string | null;
}

export interface ReplaySummary {
  replayed: number;
  failed: number;
  remaining: number;
}

export interface GraderDeps {
  db: DbLike;
  fetchFn?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem">;
  now?: () => number;
  /** Called for each queued answer graded after reconnect, so FSRS can schedule it. */
  onReplayGraded?: (row: QueueRow, result: ColabGradeResponse) => void | Promise<void>;
}

/** Network-level / tunnel-down failure: safe to queue and retry. */
class TunnelUnavailableError extends Error {}
/** Request was understood but rejected (auth, validation): retrying will not help. */
export class GraderRejectedError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const CREATE_QUEUE_SQL = `CREATE TABLE IF NOT EXISTS grading_queue (
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
)`;

export function parseGradeResponse(raw: any): ColabGradeResponse {
  const grade = Number(raw?.grade);
  if (!Number.isInteger(grade) || grade < 1 || grade > 5) {
    throw new GraderRejectedError(502, "Fleet returned an invalid grade");
  }
  return {
    grade: grade as ColabGradeResponse["grade"],
    physiologicalFeedback: String(raw.physiological_feedback ?? ""),
    missingConcepts: Array.isArray(raw.missing_concepts) ? raw.missing_concepts.map(String) : [],
  };
}

export class NgrokGrader {
  private db: DbLike;
  private fetchFn: typeof fetch;
  private storage?: Pick<Storage, "getItem" | "setItem">;
  private now: () => number;
  private onReplayGraded?: GraderDeps["onReplayGraded"];
  private url = "";
  private token = "";
  private ready?: Promise<unknown>;
  private replaying?: Promise<ReplaySummary>;
  private lastHealth: TunnelHealth | null = null;

  constructor(deps: GraderDeps) {
    this.db = deps.db;
    this.fetchFn = deps.fetchFn ?? ((...a) => fetch(...a));
    this.storage = deps.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    this.now = deps.now ?? (() => Date.now());
    this.onReplayGraded = deps.onReplayGraded;
    try {
      const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? "null");
      if (saved) {
        this.url = saved.url ?? "";
        this.token = saved.token ?? "";
      }
    } catch {
      /* ignore corrupt settings */
    }
  }

  /** Called whenever the Colab runtime restarts and ngrok hands out a new URL. */
  setTunnel(url: string, token = this.token): void {
    this.url = url.trim().replace(/\/+$/, "");
    this.token = token;
    this.lastHealth = null;
    this.storage?.setItem(STORAGE_KEY, JSON.stringify({ url: this.url, token: this.token }));
  }

  /** Registers the FSRS hook invoked for answers graded after a reconnect. */
  setReplayHandler(handler: GraderDeps["onReplayGraded"]): void {
    this.onReplayGraded = handler;
  }

  /** Most recent health probe result (null until the first check). */
  getLastHealth(): TunnelHealth | null {
    return this.lastHealth;
  }

  getTunnelUrl(): string {
    return this.url;
  }

  private ensureTable(): Promise<unknown> {
    return (this.ready ??= this.db.execute(CREATE_QUEUE_SQL));
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "1", // bypass the free-tier interstitial page
    };
    if (this.token) h["X-Fleet-Token"] = this.token;
    return h;
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    if (!this.url) throw new TunnelUnavailableError("No tunnel URL configured");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this.fetchFn(this.url + path, { ...init, headers: this.headers(), signal: ctrl.signal });
      // ngrok answers 404/502/504 with `ngrok-error-code` when the tunnel is offline or rotated
      if (res.headers.get("ngrok-error-code") || res.status === 404 || res.status === 502 || res.status === 504) {
        throw new TunnelUnavailableError(`Tunnel offline (HTTP ${res.status})`);
      }
      return res;
    } catch (e) {
      if (e instanceof TunnelUnavailableError) throw e;
      throw new TunnelUnavailableError(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  /** Verifies tunnel reachability and measures round-trip latency via GET /health. */
  async checkHealth(): Promise<TunnelHealth> {
    const t0 = this.now();
    let health: TunnelHealth;
    try {
      const res = await this.request("/health", { method: "GET" }, HEALTH_TIMEOUT_MS);
      const body = res.ok ? await res.json() : null;
      health =
        body?.status === "ok"
          ? { online: true, latencyMs: this.now() - t0, checkedAt: this.now() }
          : { online: false, latencyMs: null, checkedAt: this.now(), error: `HTTP ${res.status}` };
    } catch (e) {
      health = { online: false, latencyMs: null, checkedAt: this.now(), error: (e as Error).message };
    }
    this.lastHealth = health;
    return health;
  }

  private async postGrade(req: GradeRequest): Promise<ColabGradeResponse> {
    const res = await this.request(
      "/grade-written",
      {
        method: "POST",
        body: JSON.stringify({
          question_prompt: req.questionPrompt,
          mark_scheme: req.markScheme,
          user_answer: req.userAnswer,
        }),
      },
      GRADE_TIMEOUT_MS,
    );
    if (res.status >= 500) throw new TunnelUnavailableError(`Fleet error HTTP ${res.status}`);
    if (!res.ok) throw new GraderRejectedError(res.status, `Fleet rejected request (HTTP ${res.status})`);
    return parseGradeResponse(await res.json());
  }

  /**
   * Grades a written answer. If the tunnel is unreachable the answer is persisted to
   * SQLite and `{status: "queued"}` is returned so the UI can show "grading pending".
   */
  async gradeWritten(cardId: string, req: GradeRequest): Promise<GradeOutcome> {
    await this.ensureTable();
    try {
      return { status: "graded", result: await this.postGrade(req) };
    } catch (e) {
      if (!(e instanceof TunnelUnavailableError)) throw e;
      const queueId = await this.enqueue(cardId, req, e.message);
      this.lastHealth = { online: false, latencyMs: null, checkedAt: this.now(), error: e.message };
      return { status: "queued", queueId };
    }
  }

  private async enqueue(cardId: string, req: GradeRequest, error: string): Promise<string> {
    const id = `gq_${this.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.db.execute(
      `INSERT INTO grading_queue (id, card_id, question_prompt, mark_scheme, user_answer, enqueued_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, cardId, req.questionPrompt, req.markScheme, req.userAnswer, new Date(this.now()).toISOString(), error],
    );
    return id;
  }

  async pendingCount(): Promise<number> {
    await this.ensureTable();
    const rows = await this.db.select<{ n: number }>("SELECT COUNT(*) AS n FROM grading_queue WHERE status = 'pending'");
    return rows[0]?.n ?? 0;
  }

  /** Replays queued answers oldest-first. Stops at the first tunnel failure to preserve order. */
  replayQueue(): Promise<ReplaySummary> {
    return (this.replaying ??= this.doReplay().finally(() => {
      this.replaying = undefined;
    }));
  }

  private async doReplay(): Promise<ReplaySummary> {
    await this.ensureTable();
    const rows = await this.db.select<QueueRow>(
      "SELECT * FROM grading_queue WHERE status = 'pending' ORDER BY enqueued_at, id",
    );
    let replayed = 0;
    let failed = 0;
    for (const row of rows) {
      const req: GradeRequest = {
        questionPrompt: row.question_prompt,
        markScheme: row.mark_scheme,
        userAnswer: row.user_answer,
      };
      try {
        const result = await this.postGrade(req);
        await this.db.execute(
          "UPDATE grading_queue SET status='graded', result_json=?, graded_at=?, attempts=attempts+1 WHERE id=?",
          [JSON.stringify(result), new Date(this.now()).toISOString(), row.id],
        );
        replayed++;
        await this.onReplayGraded?.(row, result);
      } catch (e) {
        const msg = (e as Error).message;
        if (e instanceof TunnelUnavailableError) {
          await this.db.execute("UPDATE grading_queue SET attempts=attempts+1, last_error=? WHERE id=?", [msg, row.id]);
          break; // tunnel down again: keep the rest queued, in order
        }
        // Permanent rejection (or too many attempts): park it so it can't block the queue.
        const exhausted = row.attempts + 1 >= MAX_REPLAY_ATTEMPTS;
        await this.db.execute(
          "UPDATE grading_queue SET status=?, attempts=attempts+1, last_error=? WHERE id=?",
          [exhausted || e instanceof GraderRejectedError ? "failed" : "pending", msg, row.id],
        );
        failed++;
      }
    }
    return { replayed, failed, remaining: await this.pendingCount() };
  }

  /**
   * Polls tunnel health. Whenever the tunnel is (re)connected and answers are queued,
   * replays them. Returns a stop function.
   */
  startMonitor(intervalMs: number, onStatus: (h: TunnelHealth, pending: number) => void): () => void {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      const health = await this.checkHealth();
      let pending = await this.pendingCount().catch(() => 0);
      if (health.online && pending > 0) {
        const summary = await this.replayQueue().catch(() => null);
        if (summary) pending = summary.remaining;
      }
      if (!stopped) onStatus(health, pending);
    };
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}

let singleton: NgrokGrader | null = null;

/** App-wide grader backed by the real SQLite DB (tauri-plugin-sql). */
export async function getNgrokGrader(
  onReplayGraded?: GraderDeps["onReplayGraded"],
): Promise<NgrokGrader> {
  if (!singleton) {
    const { default: Database } = await import("@tauri-apps/plugin-sql");
    const db = await Database.load(SRS_DB_URL);
    singleton = new NgrokGrader({ db: db as unknown as DbLike, onReplayGraded });
  } else if (onReplayGraded) {
    singleton.setReplayHandler(onReplayGraded);
  }
  return singleton;
}
