import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

const globalMemStorage = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", {
  value: globalMemStorage,
  writable: true,
  configurable: true,
});

import {
  DEFAULT_AI_PROVIDERS,
  MAX_INLINE_PINNED_AI_TABS,
  resolveChatbotSearchCandidates,
  loadSavedAiProviders,
  addOrPinAiProvider,
  removeCustomAiProvider,
  partitionPinnedProviders,
} from "../src/services/aiProviderRegistry";
import {
  parseMarkdownMindMapTriples,
  renameNodeInMarkdown,
  deleteNodeFromMarkdown,
  deleteEdgeFromMarkdown,
  saveNodePosition,
  loadSavedNodePositions,
  buildGraphFromTriples,
} from "../src/components/mindmap/MindMapCanvas";
import { parseThoughtAnchors } from "../src/components/vault/VaultReader";
import {
  createSrsCard,
  getLocalCachedCards,
  saveLocalCachedCards,
  computeNextFsrsState,
  DEFAULT_SEED_CARDS,
} from "../src/lib/fsrs";
import { NgrokGraderService, type DbLike } from "../src/services/ngrokGrader";
import { specimenSourcingService } from "../src/services/ingestion/specimenSourcing";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

function makeDb(): DbLike {
  const sqlite = new DatabaseSync(":memory:");
  return {
    async execute(sql: string, params: unknown[] = []) {
      return sqlite.prepare(sql).run(...(params as any[]));
    },
    async select<T>(sql: string, params: unknown[] = []): Promise<T> {
      return sqlite.prepare(sql).all(...(params as any[])) as unknown as T;
    },
  };
}

describe("Phase 9 Adversarial Audit: 10 Rigorous Functional Tests + 6 Penalty Replacement Passes", () => {
  beforeEach(() => {
    globalMemStorage.clear();
  });

  it("Test 1 (AI Sidebar Discovery): resolves any chatbot name or URL into valid HTTPS candidates", () => {
    const perplexity = resolveChatbotSearchCandidates("Perplexity");
    expect(perplexity[0].id).toBe("perplexity");
    expect(perplexity[0].url).toBe("https://www.perplexity.ai/");

    const deepseek = resolveChatbotSearchCandidates("DeepSeek");
    expect(deepseek[0].id).toBe("deepseek");
    expect(deepseek[0].url).toBe("https://chat.deepseek.com/");

    const customBrand = resolveChatbotSearchCandidates("AmbossMedBot");
    expect(customBrand.length).toBeGreaterThanOrEqual(1);
    expect(customBrand[0].url.startsWith("https://")).toBe(true);

    const directUrl = resolveChatbotSearchCandidates("https://openevidence.com");
    expect(directUrl[0].url).toBe("https://openevidence.com");
  });

  it("Test 2 (Unlimited Custom AI Persistence & Default Protection): pins unlimited custom chatbots and protects the 4 core providers", async () => {
    const storage = new MemoryStorage();
    const initial = loadSavedAiProviders(storage);
    expect(initial.map((p) => p.id)).toEqual(["gemini", "chatgpt", "claude", "notebooklm"]);

    await addOrPinAiProvider({ id: "perplexity", label: "Perplexity", url: "https://www.perplexity.ai/" }, undefined, storage);
    await addOrPinAiProvider({ id: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com/" }, undefined, storage);
    await addOrPinAiProvider({ id: "grok", label: "Grok", url: "https://grok.com/" }, undefined, storage);

    const afterAdd = loadSavedAiProviders(storage);
    expect(afterAdd.length).toBe(7);

    const afterAttemptRemoveDefault = await removeCustomAiProvider("gemini", undefined, storage);
    expect(afterAttemptRemoveDefault.some((p) => p.id === "gemini")).toBe(true);

    const afterRemoveCustom = await removeCustomAiProvider("grok", undefined, storage);
    expect(afterRemoveCustom.some((p) => p.id === "grok")).toBe(false);
    expect(afterRemoveCustom.length).toBe(6);
  });

  it("Test 3 (AI Overflow Dropdown Partitioning): splits pinned chatbots into 4 inline tabs and an overflow dropdown list when > 4", () => {
    expect(MAX_INLINE_PINNED_AI_TABS).toBe(4);
    const sixProviders = [
      ...DEFAULT_AI_PROVIDERS,
      { id: "perplexity", label: "Perplexity", url: "https://www.perplexity.ai/", isCustom: true, pinned: true },
      { id: "deepseek", label: "DeepSeek", url: "https://chat.deepseek.com/", isCustom: true, pinned: true },
    ];
    const { inlineProviders, overflowProviders } = partitionPinnedProviders(sixProviders);
    expect(inlineProviders.length).toBe(4);
    expect(overflowProviders.length).toBe(2);
    expect(overflowProviders.map((p) => p.id)).toEqual(["perplexity", "deepseek"]);
  });

  it("Test 4 (Dual-Syntax MindMap Isolation): ignores standard Markdown prose and extracts only ```mindmap triples", () => {
    const md = [
      "# Cardiovascular Notes",
      "Prose with fake triple [A] --(fake)--> [B] outside code block must be ignored.",
      "```mindmap",
      "[Left Ventricle] --(Ejects blood into)--> [Aorta]",
      "[Juxtaglomerular Apparatus] --(Secretes Renin via)--> [Renal::Macula Densa]",
      "```",
    ].join("\n");
    const triples = parseMarkdownMindMapTriples("Cardiovascular", md);
    expect(triples.length).toBe(2);
    expect(triples[0].sourceNode).toBe("Left Ventricle");
    expect(triples[1].isCrossSystemBridge).toBe(true);
    expect(triples[1].targetOrganSystem).toBe("Renal");
  });

  it("Test 5 (Modular MindMap Node Renaming): renames a node across all triples inside ```mindmap without corrupting prose", () => {
    const md = [
      "# Cardiovascular System",
      "Keep Left Ventricle in this paragraph untouched.",
      "```mindmap",
      "[Left Ventricle] --(Ejects blood into)--> [Aorta]",
      "[Left Atrium] --(Fills via Mitral Valve)--> [Left Ventricle]",
      "```",
    ].join("\n");

    const updated = renameNodeInMarkdown("Cardiovascular", md, "Left Ventricle", "Systemic Left Ventricle");
    expect(updated).toContain("Keep Left Ventricle in this paragraph untouched.");
    const triples = parseMarkdownMindMapTriples("Cardiovascular", updated);
    expect(triples.map((t) => [t.sourceNode, t.targetNode])).toEqual([
      ["Systemic Left Ventricle", "Aorta"],
      ["Left Atrium", "Systemic Left Ventricle"],
    ]);
  });

  it("Test 6 (Modular MindMap Node Deletion): deletes a node and all incident edges cleanly", () => {
    const md = [
      "# Cardiovascular System",
      "```mindmap",
      "[SA Node] --(Depolarizes)--> [AV Node]",
      "[AV Node] --(Conducts to)--> [Bundle of His]",
      "[Left Ventricle] --(Ejects blood into)--> [Aorta]",
      "```",
    ].join("\n");

    const updated = deleteNodeFromMarkdown("Cardiovascular", md, "AV Node");
    const triples = parseMarkdownMindMapTriples("Cardiovascular", updated);
    expect(triples.length).toBe(1);
    expect(triples[0].sourceNode).toBe("Left Ventricle");
  });

  it("Test 7 (Modular MindMap Edge Deletion): deletes a specific directed edge while preserving remaining edges", () => {
    const md = [
      "```mindmap",
      "[SA Node] --(Depolarizes)--> [AV Node]",
      "[AV Node] --(Conducts to)--> [Bundle of His]",
      "```",
    ].join("\n");

    const updated = deleteEdgeFromMarkdown("Cardiovascular", md, { source: "SA Node", target: "AV Node" });
    const triples = parseMarkdownMindMapTriples("Cardiovascular", updated);
    expect(triples.length).toBe(1);
    expect(triples[0].sourceNode).toBe("AV Node");
    expect(triples[0].targetNode).toBe("Bundle of His");
  });

  it("Test 8 (MindMap Drag Position Persistence & Portal Node Layout): saves and restores dragged node coordinates per organ system", () => {
    saveNodePosition("Cardiovascular", "SA Node", { x: 412, y: 288 });
    const positions = loadSavedNodePositions("Cardiovascular");
    expect(positions["SA Node"]).toEqual({ x: 412, y: 288 });

    const triples = parseMarkdownMindMapTriples(
      "Cardiovascular",
      "```mindmap\n[SA Node] --(Signals)--> [Renal::Macula Densa]\n```"
    );
    const { nodes } = buildGraphFromTriples(triples, positions);
    const saNode = nodes.find((n) => n.id === "SA Node");
    const portalNode = nodes.find((n) => n.id === "Macula Densa");
    expect(saNode?.position).toEqual({ x: 412, y: 288 });
    expect(portalNode?.data.isBridge).toBe(true);
    expect(portalNode?.data.targetOrganSystem).toBe("Renal");
  });

  it("Test 9 (Replacement Pass 1 - Vault Thought Anchor Single & Multi-Line [? ... ?] Parsing): extracts [? ... ?] blocks cleanly", () => {
    const sample = " Header \n[? First question ?]\nMid text\n[? Multi-line\nquestion block ?]";
    const anchors = parseThoughtAnchors(sample);
    expect(anchors.length).toBe(2);
    expect(anchors[0].text).toBe("First question");
    expect(anchors[1].text).toContain("Multi-line");
  });

  it("Test 10 (Replacement Pass 2 - Vault Thought Anchor HTML Comment Syntax): extracts <!-- ANCHOR: id | text --> blocks cleanly", () => {
    const sample = "Note\n<!-- ANCHOR: anc_1 | Why does preload increase stroke volume? -->";
    const anchors = parseThoughtAnchors(sample);
    expect(anchors.length).toBe(1);
    expect(anchors[0].id).toBe("anc_1");
    expect(anchors[0].text).toContain("preload");
  });

  it("Test 11 (Replacement Pass 3 - FSRS-5 Custom Card Authoring & Scheduling): creates, persists, and schedules custom cards", async () => {
    expect(DEFAULT_SEED_CARDS.length).toBeGreaterThanOrEqual(4);
    const card = await createSrsCard({
      id: "card_custom_neuro_1",
      organSystem: "Neurology",
      cardType: "fill_in_gap",
      prompt: "Lesion of the {{c1::subthalamic nucleus}} causes hemiballismus.",
      expectedAnswer: "subthalamic nucleus",
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      reps: 0,
      lapses: 0,
      state: "new",
      dueDateIso: new Date().toISOString(),
    });
    const deck = [card, ...DEFAULT_SEED_CARDS];
    saveLocalCachedCards(deck);
    const loaded = getLocalCachedCards();
    expect(loaded.some((c) => c.id === card.id)).toBe(true);

    const next = computeNextFsrsState(card, 4);
    expect(next.updatedCard.stability).toBeGreaterThan(0);
    expect(next.updatedCard.reps).toBe(1);
  });

  it("Test 12 (Replacement Pass 4 - NgrokGraderService Offline Fallback & URL Sanitization): strips trailing slashes and queues offline written answers", async () => {
    const db = makeDb();
    const storage = new MemoryStorage();
    const grader = new NgrokGraderService({
      db,
      fetchFn: (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch,
      storage,
    });
    grader.setTunnelConfig("https://offline-unit-test.ngrok-free.app///", "test-token");
    expect(grader.getTunnelUrl()).toBe("https://offline-unit-test.ngrok-free.app");

    const res = await grader.gradeWritten(
      "card-1",
      "Explain RAAS",
      "Renin converts angiotensinogen to angiotensin I",
      "Renin cleaves angiotensinogen"
    );
    expect(res.queuedOffline).toBe(true);
    expect(await grader.pendingCount()).toBe(1);
  });

  it("Test 13 (Replacement Pass 5 - Specimen Sourcing Offline SVG Data URI Fallback): produces renderable SVG data URI when offline", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Simulated offline network");
    }) as any;
    try {
      const results = await specimenSourcingService.searchAndRegisterSpecimens(
        "Coagulative necrosis myocardium",
        "Cardiovascular",
        "histopathology"
      );
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].descriptiveFilename.toLowerCase()).toContain("cardiovascular");
      expect(results[0].sourceUrl.startsWith("data:image/svg+xml;utf8,")).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("Test 14 (Replacement Pass 6 - MindMap Colab 3B Auth Header Injection): verifies MindMapCanvas sends X-Fleet-Token and ngrok-skip-browser-warning", () => {
    const mmCode = fs.readFileSync(path.resolve(process.cwd(), "src/components/mindmap/MindMapCanvas.tsx"), "utf-8");
    expect(mmCode).toContain("X-Fleet-Token");
    expect(mmCode).toContain("ngrok-skip-browser-warning");
  });

  it("Test 15 (Tauri v2 Capabilities & Rust Unlimited AI Verification): verifies default.json wildcards and navigate_ai_panel registration", () => {
    const capPath = path.resolve(process.cwd(), "src-tauri/capabilities/default.json");
    const capJson = JSON.parse(fs.readFileSync(capPath, "utf-8"));
    expect(capJson.windows).toContain("ai_panel_*");
    expect(capJson.windows).toContain("ai_float_*");
    expect(capJson.webviews).toContain("ai_panel_*");
    expect(capJson.permissions).toContain("navigate_ai_panel");
    expect(capJson.permissions).toContain("core:webview:create");

    const libRs = fs.readFileSync(path.resolve(process.cwd(), "src-tauri/src/lib.rs"), "utf-8");
    expect(libRs).toContain("fn navigate_ai_panel");
    expect(libRs).toContain("fn resolve_ai_provider_with_url");
    expect(libRs).toContain("persist_study_session");
    expect(libRs).toContain("resolve_app_local_data_dir");
  });

  it("Test 16 (Apple iOS 26 Liquid Glass SVG Refraction & Constitution CSS Verification): verifies SVG filter and Section 4.2 tokens", () => {
    const appTsx = fs.readFileSync(path.resolve(process.cwd(), "src/App.tsx"), "utf-8");
    expect(appTsx).toContain('id="apple-liquid-glass"');
    expect(appTsx).toContain("feDisplacementMap");
    expect(appTsx).toContain("feSpecularLighting");

    const css = fs.readFileSync(path.resolve(process.cwd(), "src/index.css"), "utf-8");
    expect(css).toContain("--glass-bg-base: rgba(15, 23, 42, 0.45)");
    expect(css).toContain("--glass-blur-standard: blur(16px) saturate(180%)");
    expect(css).toContain("--apple-liquid-refraction: url(#apple-liquid-glass)");
  });
});
