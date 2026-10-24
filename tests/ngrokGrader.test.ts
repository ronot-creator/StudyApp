import { describe, expect, it, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";

// Mock localStorage before importing the module
const mockLocalStorage = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};
Object.defineProperty(globalThis, "localStorage", {
  value: mockLocalStorage,
  writable: true,
});

import { NgrokGraderService, GraderRejectedError, type DbLike, type QueueRow } from "../src/services/ngrokGrader";

// Vite 5 cannot resolve the `node:sqlite` builtin through import; load it via require.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

function makeDb(): DbLike {
  const sqlite = new DatabaseSync(":memory:");
  return {
    async execute(sql, params = []) {
      return sqlite.prepare(sql).run(...(params as any[]));
    },
    async select(sql, params = []) {
      return sqlite.prepare(sql).all(...(params as any[])) as any;
    },
  };
}

type Mode = "online" | "ngrok-offline" | "network-error" | "rejected" | "server-error";

function makeFetch(state: { mode: Mode; calls: string[] }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    state.calls.push(`${init?.method} ${url}`);
    if (state.mode === "network-error") throw new TypeError("Failed to fetch");
    if (state.mode === "ngrok-offline") {
      return new Response("tunnel gone", { status: 404, headers: { "ngrok-error-code": "ERR_NGROK_3200" } });
    }
    if (state.mode === "rejected") return new Response("{}", { status: 401 });
    if (state.mode === "server-error") return new Response("{}", { status: 500 });
    if (url.endsWith("/health")) return Response.json({ status: "ok", model: "qwen2.5:3b-instruct" });
    // grade-written endpoint
    return Response.json({
      card_id: "c1",
      grade: 4,
      physiological_feedback: "Good",
      missing_concepts: ["V2"],
      evaluator_model: "qwen2.5:3b-instruct",
    });
  }) as unknown as typeof fetch;
}

const REQ = { questionPrompt: "q", markScheme: "m", userAnswer: "a" };
const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("NgrokGraderService", () => {
  let state: { mode: Mode; calls: string[] };
  let db: DbLike;
  let graded: Array<[QueueRow, number]>;
  let grader: NgrokGraderService;

  beforeEach(() => {
    state = { mode: "online", calls: [] };
    db = makeDb();
    graded = [];
    grader = new NgrokGraderService({
      db,
      fetchFn: makeFetch(state),
      storage: mem(),
      onReplayGraded: (row, res) => void graded.push([row, res.grade]),
    });
    grader.setTunnelConfig("https://abc.ngrok-free.app/", "tok");
  });

  it("grades online and maps snake_case to camelCase", async () => {
    const out = await grader.gradeWritten("c1", REQ.questionPrompt, REQ.markScheme, REQ.userAnswer);
    expect(out).toEqual({
      cardId: "c1",
      grade: 4,
      physiologicalFeedback: "Good",
      missingConcepts: ["V2"],
      evaluatorModel: "qwen2.5:3b-instruct",
      queuedOffline: false,
    });
    expect(state.calls[0]).toBe("POST https://abc.ngrok-free.app/grade-written");
    expect(await grader.pendingCount()).toBe(0);
  });

  it("measures health latency and reports offline", async () => {
    const h = await grader.checkHealth();
    expect(h.online).toBe(true);
    expect(h.latencyMs).not.toBeNull();
    state.mode = "ngrok-offline";
    const off = await grader.checkHealth();
    expect(off.online).toBe(false);
    expect(off.latencyMs).toBeNull();
  });

  it("queues when the tunnel drops (network error) and replays when online", async () => {
    state.mode = "network-error";
    const a = await grader.gradeWritten("c1", REQ.questionPrompt, REQ.markScheme, "first");
    expect(a.queuedOffline).toBe(true);
    expect(await grader.pendingCount()).toBe(1);

    state.mode = "online";
    const replayed = await grader.replayQueue();
    expect(replayed).toBe(1);
    expect(graded.length).toBe(1);
    expect(graded[0][1]).toBe(4);
    expect(await grader.pendingCount()).toBe(0);
  });

  it("does not queue permanent rejections (bad token)", async () => {
    state.mode = "rejected";
    await expect(
      grader.gradeWritten("c1", REQ.questionPrompt, REQ.markScheme, REQ.userAnswer)
    ).rejects.toBeInstanceOf(GraderRejectedError);
    expect(await grader.pendingCount()).toBe(0);
  });

  it("queues on fleet 5xx", async () => {
    state.mode = "server-error";
    const out = await grader.gradeWritten("c1", REQ.questionPrompt, REQ.markScheme, REQ.userAnswer);
    expect(out.queuedOffline).toBe(true);
  });

  it("persists tunnel config across instances", () => {
    const storage = mem();
    new NgrokGraderService({ db, storage }).setTunnelConfig("https://x.ngrok-free.app/", "t");
    expect(new NgrokGraderService({ db, storage }).getTunnelUrl()).toBe("https://x.ngrok-free.app");
  });
});