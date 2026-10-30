import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  clearCachedAppLocalDataRoot,
  readStorageBootstrapConfig,
  resolveAppDataSubPath,
  resolveAppLocalDataRoot,
  setCustomStorageTargetDir,
  STORAGE_CONFIG_MAX_BYTES,
} from "../src/lib/appPaths";
import {
  API_NOT_FOUND_CODE,
  ApiNotFoundError,
  generateWithGemma31b,
} from "../src/services/aiStudio";
import {
  detectLanguageOffline,
  extractPdfTextLocal,
  resolveTesseractLocalCache,
  takeFirstWords,
} from "../src/services/ingestion/fileIngestion";
import {
  ANKI_CONNECT_URL,
  checkAnkiConnectStatus,
  DEFAULT_CONVERGENCE_DECK,
  ensureConvergenceDeckExists,
  pushFlashcardsToAnki,
} from "../src/services/ankiConnect";
import { parseCommandTaxonomy } from "../src/services/commandTaxonomy";
import {
  parseMarkdownFootnotes,
  upsertMarkdownFootnote,
} from "../src/components/vault/VaultReader";

vi.mock("tesseract.js", () => ({
  default: {
    createWorker: vi.fn(async (lang: string, _oem: number, opts: any) => ({
      recognize: async () => ({
        data: {
          text: `OCR (${lang}) cached at ${opts?.cachePath}`,
          confidence: 95.0,
        },
      }),
      terminate: async () => {},
    })),
    recognize: vi.fn(async (_img: unknown, lang: string) => ({
      data: {
        text: `OCR (${lang})`,
        confidence: 95.0,
      },
    })),
  },
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: ({ data }: { data: Uint8Array }) => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => ({
          items: [{ str: new TextDecoder("utf-8").decode(data) }],
        }),
      }),
    }),
  }),
}));

const REPO_ROOT = path.resolve(__dirname, "..");

function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, val: string) => {
      map.set(key, val);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("Phase 12 UX Polish, Guardrails, & Integrations Suite", () => {
  it("Step 1: routes Vault, Images, Tesseract, and Partitions via <=1KB storage_config.json to custom drive (e.g. D:\\Convergence) and throws API_NOT_FOUND when Gemma key is missing", async () => {
    const store = createMemoryStorage();
    clearCachedAppLocalDataRoot();

    const cfg = await setCustomStorageTargetDir("D:\\Convergence", store);
    expect(JSON.stringify(cfg).length).toBeLessThanOrEqual(STORAGE_CONFIG_MAX_BYTES);
    expect(cfg.customTargetDir).toBe("D:\\Convergence");

    const loadedCfg = await readStorageBootstrapConfig(store);
    expect(loadedCfg?.customTargetDir).toBe("D:\\Convergence");

    const root = await resolveAppLocalDataRoot(store);
    expect(root).toBe("D:\\Convergence");

    const vaultPath = await resolveAppDataSubPath("vault", "Renal.md");
    expect(vaultPath).toBe("D:\\Convergence\\vault\\Renal.md");

    const imagesPath = await resolveAppDataSubPath("images", "glomerulus.png");
    expect(imagesPath).toBe("D:\\Convergence\\images\\glomerulus.png");

    // Reset custom drive override so subsequent tests use default
    await setCustomStorageTargetDir("", store);
    clearCachedAppLocalDataRoot();

    // Circuit Breaker throws API_NOT_FOUND immediately when key is empty
    await expect(generateWithGemma31b("Explain GFR", undefined, { apiKey: "" })).rejects.toThrow(
      ApiNotFoundError
    );
    try {
      await generateWithGemma31b("Explain GFR", undefined, { apiKey: "   " });
    } catch (err: any) {
      expect(err.code).toBe(API_NOT_FOUND_CODE);
      expect(err.message).toContain("API_NOT_FOUND");
    }

    const modalSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/ui/ApiKeyGuardrailModal.tsx"),
      "utf-8"
    );
    expect(modalSrc).toContain("api-guardrail-dismiss-x");
    expect(modalSrc).toContain("ApiKeyErrorBoundary");
  });

  it("Step 2: detects English, Arabic, and Spanish offline via franc-min from first 50 words and configures Tesseract cachePath & langPath to $APPLOCALDATA/tesseract_langs", async () => {
    const engSample =
      "The renal corpuscle autoregulates glomerular filtration rate across systemic arterial blood pressures through myogenic stretch and macula densa tubuloglomerular feedback mechanisms in the kidney.";
    const araSample =
      "يقوم الجهاز الكلوي بتنظيم معدل الترشيح الكبيبي في الكلى عبر آليات التغذية الراجعة الأنبوبية الكبيبية وتضيق الشرين الوارد للحفاظ على التوازن الفسيولوجي.";
    const spaSample =
      "La fisiología renal regula la presión de filtración glomerular mediante la arteria aferente y el sistema renina angiotensina aldosterona en el riñón humano.";

    expect(detectLanguageOffline(engSample).tesseractLang).toBe("eng");
    expect(detectLanguageOffline(araSample).tesseractLang).toBe("ara");
    expect(detectLanguageOffline(spaSample).tesseractLang).toBe("spa");

    const sixtyWords = Array.from({ length: 60 }, (_, i) => `word${i + 1}`).join(" ");
    expect(takeFirstWords(sixtyWords, 50).split(" ")).toHaveLength(50);

    const cacheCfg = await resolveTesseractLocalCache("spa");
    expect(cacheCfg.cachePath).toContain("tesseract_langs");
    expect(cacheCfg.langPath).toContain("tesseract_langs");
    expect(cacheCfg.checkedFiles[0]).toContain("spa.traineddata");

    const pdfBytes = new TextEncoder().encode(spaSample);
    const extracted = await extractPdfTextLocal(pdfBytes);
    expect(extracted.detectedLang).toBe("spa");
    expect(extracted.tesseractCache.cachePath).toContain("tesseract_langs");
  });

  it("Step 3: syncs flashcards to AnkiConnect (http://127.0.0.1:8765) via createDeck ('Convergence') and addNotes", async () => {
    expect(ANKI_CONNECT_URL).toBe("http://127.0.0.1:8765");
    expect(DEFAULT_CONVERGENCE_DECK).toBe("Convergence");

    const recordedActions: Array<{ action: string; params?: any }> = [];
    const mockFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      recordedActions.push({ action: body.action, params: body.params });
      if (body.action === "version") {
        return { ok: true, status: 200, json: async () => ({ result: 6, error: null }) };
      }
      if (body.action === "createDeck") {
        return { ok: true, status: 200, json: async () => ({ result: 1709912345, error: null }) };
      }
      if (body.action === "addNotes") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ result: [9001, 9002], error: null }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ result: null, error: null }) };
    });

    const status = await checkAnkiConnectStatus({ fetchImpl: mockFetch as any });
    expect(status.connected).toBe(true);
    expect(status.version).toBe(6);

    const deckId = await ensureConvergenceDeckExists("Convergence", {
      fetchImpl: mockFetch as any,
    });
    expect(deckId).toBe(1709912345);

    const syncRes = await pushFlashcardsToAnki(
      [
        {
          frontPrompt: "Mechanism of SGLT2 inhibition in proximal tubule?",
          markScheme: "Blocks Na+/glucose cotransport, increasing NaCl delivery to macula densa.",
          cardType: "written",
          questionOrder: 2,
          organSystem: "Renal",
        },
        {
          frontPrompt: "Effect of ANP on efferent vs afferent arteriole?",
          markScheme: "Dilates afferent arteriole and constricts efferent arteriole, raising GFR.",
          cardType: "written",
          questionOrder: 2,
          organSystem: "Renal",
        },
      ],
      "Convergence",
      { fetchImpl: mockFetch as any }
    );

    expect(syncRes.deckName).toBe("Convergence");
    expect(syncRes.succeededCount).toBe(2);
    expect(recordedActions.map((a) => a.action)).toEqual(["version", "createDeck", "createDeck", "addNotes"]);
    expect(recordedActions[3].params.notes[0].deckName).toBe("Convergence");
  });

  it("Step 4: parses /q([smwt]+) and /u([ade]*) command taxonomy with even weight division, Grammarly mouseup tooltip, and [^1] react-rnd footnote overlay", () => {
    const qTwo = parseCommandTaxonomy("/qsm renal hemodynamics", "GFR context");
    expect(qTwo?.mode).toBe("assessment");
    expect(qTwo?.flags).toEqual(["s", "m"]);
    expect(qTwo?.allocations).toEqual([
      { flag: "s", label: "Scenarios", weightPct: 50 },
      { flag: "m", label: "MCQ", weightPct: 50 },
    ]);
    expect(qTwo?.masterPrompt).toContain("INVISIBLE GEMMA 31B MASTER PROMPT");
    expect(qTwo?.masterPrompt).toContain("Scenarios (S): 50%, MCQ (M): 50%");

    const qAll = parseCommandTaxonomy("/qsmwt nephrotic syndrome");
    expect(qAll?.allocations.map((a) => a.weightPct)).toEqual([25, 25, 25, 25]);

    const uTwo = parseCommandTaxonomy("/uad countercurrent multiplier");
    expect(uTwo?.mode).toBe("comprehension");
    expect(uTwo?.allocations).toEqual([
      { flag: "a", label: "Analogy & Intuition", weightPct: 50 },
      { flag: "d", label: "Deep Mechanism & Derivation", weightPct: 50 },
    ]);

    const uDefault = parseCommandTaxonomy("/u tubuloglomerular feedback");
    expect(uDefault?.flags).toEqual(["a", "d", "e"]);
    expect(uDefault?.allocations[0].weightPct).toBeCloseTo(33.33, 1);

    const preloadSrc = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/preload.js"), "utf-8");
    expect(preloadSrc).toContain("/^\\/q([smwt]+)");
    expect(preloadSrc).toContain("/^\\/u([ade]*)");
    expect(preloadSrc).toContain('addEventListener("mouseup"');
    expect(preloadSrc).toContain("+ Add Note");

    // Verify [^1] footnote parser & bottom-of-file appender + react-rnd overlay in VaultReader.tsx
    const md = "# Renal Note\n\nGlomerular filtration barrier[^1].\n\n[^1]: Initial footnote.";
    const parsedFn = parseMarkdownFootnotes(md);
    expect(parsedFn).toEqual([{ id: "1", text: "Initial footnote." }]);

    const updatedMd = upsertMarkdownFootnote(md, "2", "Podocyte slit diaphragm nephrin.");
    expect(updatedMd.trim().endsWith("[^2]: Podocyte slit diaphragm nephrin.")).toBe(true);

    const vrSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/vault/VaultReader.tsx"),
      "utf-8"
    );
    expect(vrSrc).toContain('from "react-rnd"');
    expect(vrSrc).toContain("footnote-rnd-overlay");
  });
});
