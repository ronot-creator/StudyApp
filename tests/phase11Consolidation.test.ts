import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  addOrPinAiProvider,
  DEFAULT_AI_PROVIDERS,
  getProviderPartition,
  loadSavedAiProviders,
} from "../src/services/aiProviderRegistry";
import {
  executeOmnibarCanvasCommand,
  extractMindMapTriplesWithGemma,
  GEMMA_31B_MODEL_ID,
  generateFsrsCardsWithGemma,
  getAiStudioApiKey,
  hasAiStudioApiKey,
  parseConnectCommandLocally,
  saveDualTunnelConfig,
  setAiStudioApiKey,
} from "../src/services/aiStudio";
import {
  DEFAULT_OCR_LANGUAGE,
  extractImageOcrLocal,
  extractPdfTextLocal,
  handleReactDropzoneFiles,
  sanitizeIngestionStem,
} from "../src/services/ingestion/fileIngestion";
import {
  appendTripleToVaultMarkdown,
  parseMarkdownMindMapTriples,
} from "../src/components/mindmap/MindMapCanvas";

vi.mock("tesseract.js", () => ({
  default: {
    recognize: vi.fn(async (_img: unknown, lang: string) => ({
      data: {
        text: `Extracted OCR text (${lang}): Glomerular filtration barrier & podocyte foot processes`,
        confidence: 96.4,
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

describe("Phase 11 Master Consolidation Verification Suite", () => {
  it("Step 1: provides src-tauri/src/preload.js & fileIngestion.ts with pdfjs-dist and tesseract.js (lang: 'eng+ara')", async () => {
    const preloadPath = path.join(REPO_ROOT, "src-tauri/src/preload.js");
    expect(fs.existsSync(preloadPath)).toBe(true);
    const preloadSrc = fs.readFileSync(preloadPath, "utf-8");
    expect(preloadSrc).toContain("resolve_shorthand_query");
    expect(preloadSrc).toContain("window.__TAURI__.core.invoke");

    expect(DEFAULT_OCR_LANGUAGE).toBe("eng+ara");
    expect(sanitizeIngestionStem("Renal Lecture #1.pdf")).toBe("Renal_Lecture_1");

    const ocrRes = await extractImageOcrLocal(new Uint8Array([137, 80, 78, 71]));
    expect(ocrRes.ocrLanguage).toBe("eng+ara");

    const samplePdfBytes = new TextEncoder().encode("Macula densa senses distal NaCl delivery.");
    const pdfRes = await extractPdfTextLocal(samplePdfBytes);
    expect(pdfRes.text).toContain("Macula densa");

    const fakeImageFile = new File([new Uint8Array([1, 2, 3, 4])], "nephron.png", { type: "image/png" });
    const fakePdfFile = new File([samplePdfBytes], "renal.pdf", { type: "application/pdf" });
    const batchResults = await handleReactDropzoneFiles([fakeImageFile, fakePdfFile], {
      targetVaultPrefix: "Renal",
    });
    expect(batchResults).toHaveLength(2);
    expect(batchResults[0].savedImagePath).toContain("images");
    expect(batchResults[0].savedMarkdownPath).toContain("vault");
  });

  it("Step 2: connects to Google AI Studio (gemma-4-31b-it) and configures Dual-Tunnel in AiIntegrations.tsx", async () => {
    const store = createMemoryStorage();
    setAiStudioApiKey("AIzaSyTestGemma31bKey", store);
    expect(hasAiStudioApiKey(store)).toBe(true);
    expect(getAiStudioApiKey(store)).toBe("AIzaSyTestGemma31bKey");

    const dualCfg = saveDualTunnelConfig({ preferGemmaWhenKeyPresent: true }, store);
    expect(dualCfg.primaryEngine).toBe("gemma-4-31b-it");
    expect(dualCfg.mcpSidecarUrl).toBe("http://localhost:1420/mcp");

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      expect(url).toContain(GEMMA_31B_MODEL_ID);
      const body = JSON.parse(String(init?.body || "{}"));
      const promptText = body?.contents?.[0]?.parts?.[0]?.text || "";
      if (promptText.includes("Extract physiological flow relationships")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  text: JSON.stringify({
                    triples: [{
                      source_node: "Macula Densa",
                      linking_phrase: "releases adenosine to constrict",
                      target_node: "Afferent Arteriole",
                      is_cross_system_bridge: false,
                      target_organ_system: null,
                    }],
                  }),
                }],
              },
            }],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                text: JSON.stringify({
                  cards: [{
                    frontPrompt: "Effect of ACEi in bilateral renal artery stenosis?",
                    markScheme: "Drop in efferent tone lowers GFR.",
                    cardType: "written",
                    questionOrder: 2,
                  }],
                }),
              }],
            },
          }],
        }),
      };
    });

    const triples = await extractMindMapTriplesWithGemma("Macula densa text", "Renal", {
      apiKey: "AIzaSyTestGemma31bKey",
      fetchImpl: mockFetch as any,
    });
    expect(triples).toHaveLength(1);
    expect(triples[0].source_node).toBe("Macula Densa");

    const cards = await generateFsrsCardsWithGemma("RAS text", "Renal", 1, {
      apiKey: "AIzaSyTestGemma31bKey",
      fetchImpl: mockFetch as any,
    });
    expect(cards).toHaveLength(1);
    expect(cards[0].questionOrder).toBe(2);
  });

  it("Step 3: assigns persist:ai_[slug] partitions and exposes spawn_custom_ai_panel", async () => {
    const store = createMemoryStorage();
    expect(DEFAULT_AI_PROVIDERS[0].partition).toBe("persist:ai_gemini");
    expect(getProviderPartition("DeepSeek Medical")).toBe("persist:ai_deepseek_medical");

    const { added } = await addOrPinAiProvider(
      { label: "DeepSeek Medical", url: "https://chat.deepseek.com/" },
      undefined,
      store
    );
    expect(added.partition).toBe("persist:ai_deepseek_medical");
    const reloaded = loadSavedAiProviders(store);
    expect(reloaded.some((p) => p.partition === "persist:ai_deepseek_medical")).toBe(true);

    const libRs = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf-8");
    expect(libRs).toContain("fn spawn_custom_ai_panel");
    expect(libRs).toContain("persist:ai_{clean_slug}");
  });

  it("Step 4: routes 'Connect X to Y' Omnibar prompts and updates MindMap triples", async () => {
    const localMutation = parseConnectCommandLocally(
      "Connect Podocyte Foot Processes to Glomerular Basement Membrane via slit diaphragm filtration",
      "Renal"
    );
    expect(localMutation?.triples[0].source_node).toBe("Podocyte Foot Processes");

    const initialMd = "```mindmap\n[Afferent Arteriole] --(supplies)--> [Glomerulus]\n```";
    const mutation = await executeOmnibarCanvasCommand(
      "Connect Glomerulus to Proximal Convoluted Tubule via ultrafiltration",
      "Renal",
      initialMd
    );
    const t = mutation.triples[0];
    const updatedMd = appendTripleToVaultMarkdown(
      initialMd,
      `[${t.source_node}] --(${t.linking_phrase})--> [${t.target_node}]`
    );
    const parsedTriples = parseMarkdownMindMapTriples("Renal", updatedMd);
    expect(parsedTriples).toHaveLength(2);
  });

  it("Step 5: strips static ORGAN_SYSTEMS lists from colab-fleet while preserving q8_0 GGUF fallback", () => {
    const fleetServer = fs.readFileSync(path.join(REPO_ROOT, "colab-fleet/fleet_server.py"), "utf-8");
    expect(fleetServer).not.toContain("CANONICAL_ORGAN_SYSTEMS");
    expect(fleetServer).not.toContain("ORGAN_SYSTEMS = [");
    expect(fleetServer).toContain("categories: Optional[List[str]] = None");
    expect(fleetServer).toContain("q8_0");
  });
});
