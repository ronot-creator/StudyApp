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
    if (url.endsWith("/health")) return Response.json({ status: "ok" });
    return Response.json({ grade: 4, physiological_feedback: "Good", missing_concepts: ["V2"] });
  }) as unknown as typeof fetch;
}

const REQ = { questionPrompt: "q", markScheme: "m", userAnswer: "a" };
const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe("NgrokGrader", () => {
  let state: { mode: Mode; calls: string[] };
  let db: DbLike;
  let graded: Array<[QueueRow, number]>;
  let grader: NgrokGrader;

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
    const out = await grader.gradeWritten("c1", REQ);
    expect(out).toEqual({
      status: "graded",
      result: { grade: 4, physiologicalFeedback: "Good", missingConcepts: ["V2"] },
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
    expect(off.error).toMatch(/offline/);
  });

  it("queues when the tunnel drops (network error or rotated ngrok URL) and replays in order", async () => {
    state.mode = "network-error";
    const a = await grader.gradeWritten("c1", { ...REQ, userAnswer: "first" });
    state.mode = "ngrok-offline";
    const b = await grader.gradeWritten("c2", { ...REQ, userAnswer: "second" });
    expect(a.status).toBe("queued");
    expect(b.status).toBe("queued");
    expect(await grader.pendingCount()).toBe(2);

    // still down: replay keeps everything queued
    expect(await grader.replayQueue()).toEqual({ replayed: 0, failed: 0, remaining: 2 });

    state.mode = "online";
    grader.setTunnel("https://new-url.ngrok-free.app");
    const summary = await grader.replayQueue();
    expect(summary).toEqual({ replayed: 2, failed: 0, remaining: 0 });
    expect(graded.map(([r]) => r.card_id)).toEqual(["c1", "c2"]);
    expect(graded.every(([, g]) => g === 4)).toBe(true);
    const rows = await db.select<QueueRow>("SELECT status, result_json FROM grading_queue");
    expect(rows.every((r) => r.status === "graded" && r.result_json)).toBe(true);
  });

  it("does not queue permanent rejections (bad token)", async () => {
    state.mode = "rejected";
    await expect(grader.gradeWritten("c1", REQ)).rejects.toBeInstanceOf(GraderRejectedError);
    expect(await grader.pendingCount()).toBe(0);
  });

  it("parks permanently rejected queued rows so they cannot block the queue", async () => {
    state.mode = "network-error";
    await grader.gradeWritten("c1", REQ);
    state.mode = "rejected";
    expect(await grader.replayQueue()).toEqual({ replayed: 0, failed: 1, remaining: 0 });
    const rows = await db.select<QueueRow>("SELECT status FROM grading_queue");
    expect(rows[0].status).toBe("failed");
  });

  it("queues on fleet 5xx", async () => {
    state.mode = "server-error";
    expect((await grader.gradeWritten("c1", REQ)).status).toBe("queued");
  });

  it("monitor replays automatically when the tunnel comes back", async () => {
    state.mode = "network-error";
    await grader.gradeWritten("c1", REQ);
    const seen: Array<[boolean, number]> = [];
    const stop = grader.startMonitor(20, (h, p) => void seen.push([h.online, p]));
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.at(-1)).toEqual([false, 1]);
    state.mode = "online";
    await new Promise((r) => setTimeout(r, 120));
    stop();
    expect(seen.at(-1)).toEqual([true, 0]);
    expect(graded).toHaveLength(1);
  });

  it("persists tunnel config across instances", () => {
    const storage = mem();
    new NgrokGrader({ db, storage }).setTunnel("https://x.ngrok-free.app/", "t");
    expect(new NgrokGrader({ db, storage }).getTunnelUrl()).toBe("https://x.ngrok-free.app");
  });
});
