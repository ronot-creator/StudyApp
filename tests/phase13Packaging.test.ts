import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  pickDirectoryWithTauriDialog,
  runWizardScaffoldingSequence,
} from "../src/components/setup/FirstRunWizard";
import { clearCachedAppLocalDataRoot, setCustomStorageTargetDir } from "../src/lib/appPaths";
import {
  handleReactDropzoneFiles,
  ingestFileByPath,
  RAW_ASSETS_SUBDIR,
} from "../src/services/ingestion/fileIngestion";
import {
  fetchAvailableModels,
  GEMMA_31B_MODEL_ID,
  getAiStudioApiKey,
  loadAiStudioApiKeyFromStronghold,
  saveAiStudioApiKeyToStronghold,
  setAiStudioApiKey,
} from "../src/services/aiStudio";
import {
  getEncryptedVaultCipherBytes,
  STRONGHOLD_AI_STUDIO_KEY_RECORD,
} from "../src/services/strongholdKeystore";

vi.mock("tesseract.js", () => ({
  default: {
    createWorker: vi.fn(async (lang: string) => ({
      recognize: async () => ({
        data: {
          text: `Verbatim OCR transcript (${lang}): Juxtaglomerular apparatus renin secretion`,
          confidence: 97.2,
        },
      }),
      terminate: async () => {},
    })),
    recognize: vi.fn(async (_img: unknown, lang: string) => ({
      data: {
        text: `Verbatim OCR transcript (${lang})`,
        confidence: 97.2,
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

describe("Phase 13 Setup Wizard, Stronghold Security, & Tauri Packaging Suite", () => {
  it("Step 1: implements 3-step FirstRunWizard (EULA -> dialog.open({ directory: true }) -> Scaffolding Progress Bar) creating vault, images, and raw_assets", async () => {
    const wizardPath = path.join(REPO_ROOT, "src/components/setup/FirstRunWizard.tsx");
    expect(fs.existsSync(wizardPath)).toBe(true);
    const wizardSrc = fs.readFileSync(wizardPath, "utf-8");
    expect(wizardSrc).toContain("@tauri-apps/plugin-dialog");
    expect(wizardSrc).toContain("dialog.open({");
    expect(wizardSrc).toContain("directory: true");

    const store = createMemoryStorage();
    clearCachedAppLocalDataRoot();
    const recordedPercentages: number[] = [];

    const finalState = await runWizardScaffoldingSequence(
      "D:\\Convergence",
      (st) => recordedPercentages.push(st.percent),
      store
    );

    expect(recordedPercentages).toEqual([33, 66, 100]);
    expect(finalState.completedSteps).toEqual([
      "storage_config.json",
      "sqlite_schema_migrations",
      "subdirectories_created",
    ]);
    expect(finalState.createdSubdirs).toEqual([
      "D:\\Convergence\\vault",
      "D:\\Convergence\\images",
      "D:\\Convergence\\raw_assets",
    ]);

    const pickedFallback = await pickDirectoryWithTauriDialog("D:\\Convergence");
    expect(pickedFallback).toBe("D:\\Convergence");

    await setCustomStorageTargetDir("", store);
    clearCachedAppLocalDataRoot();
  });

  it("Step 2: non-destructively copies ingested files to $APPLOCALDATA/raw_assets and writes strictly verbatim text to $APPLOCALDATA/vault/*.md", async () => {
    expect(RAW_ASSETS_SUBDIR).toBe("raw_assets");

    const verbatimPdfContent =
      "Verbatim physiological text: Proximal convoluted tubule reabsorbs 65% of filtered Na+ and water.";
    const pdfFile = new File(
      [new TextEncoder().encode(verbatimPdfContent)],
      "proximal_tubule.pdf",
      { type: "application/pdf" }
    );

    const results = await handleReactDropzoneFiles([pdfFile], {
      targetVaultPrefix: "Renal",
    });

    expect(results).toHaveLength(1);
    expect(results[0].savedRawAssetPath).toContain("raw_assets");
    expect(results[0].savedRawAssetPath).toContain("Renal_proximal_tubule.pdf");
    expect(results[0].savedMarkdownPath).toContain("vault");
    // Must be strictly the verbatim text without wrapper headers
    expect(results[0].extractedText).toBe(verbatimPdfContent);

    const pathResult = await ingestFileByPath("C:\\Lectures\\glomerulus_notes.pdf", {
      targetVaultPrefix: "Renal",
    });
    expect(pathResult.savedRawAssetPath).toContain("raw_assets");
  });

  it("Step 3: encrypts API keys in Tauri Stronghold (bypassing plaintext localStorage) and queries /models to auto-select gemma-4-31b-it", async () => {
    await saveAiStudioApiKeyToStronghold("AIzaSyStrongholdEncryptedSecretKey99");
    const loadedKey = await loadAiStudioApiKeyFromStronghold();
    expect(loadedKey).toBe("AIzaSyStrongholdEncryptedSecretKey99");
    expect(getAiStudioApiKey()).toBe("AIzaSyStrongholdEncryptedSecretKey99");

    // Verify encrypted cipher bytes are NOT equal to plaintext bytes
    const cipherBytes = getEncryptedVaultCipherBytes(STRONGHOLD_AI_STUDIO_KEY_RECORD);
    expect(cipherBytes).toBeDefined();
    const rawPlainBytes = new TextEncoder().encode("AIzaSyStrongholdEncryptedSecretKey99");
    expect(Buffer.from(cipherBytes!).equals(Buffer.from(rawPlainBytes))).toBe(false);

    // Clear key after test
    setAiStudioApiKey("");

    // Test dynamic /models endpoint detection & auto-selection of gemma-4-31b-it
    const mockFetch = vi.fn(async (url: string) => {
      expect(url).toContain("/models");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: "models/gemini-2.5-flash" },
            { name: "models/gemma-4-31b-it" },
            { name: "models/gemini-2.5-pro" },
          ],
        }),
      };
    });

    const detected = await fetchAvailableModels({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "AIzaTestKey",
      fetchImpl: mockFetch as any,
    });

    expect(detected.models).toEqual([
      "gemini-2.5-flash",
      "gemma-4-31b-it",
      "gemini-2.5-pro",
    ]);
    expect(detected.selectedModel).toBe(GEMMA_31B_MODEL_ID);
  });

  it("Step 4: configures PyInstaller sidecar in mcp-server/build_sidecar.py, tauri.conf.json externalBin, and src-tauri/build.rs", () => {
    const tauriConf = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf-8")
    );
    expect(tauriConf.bundle.externalBin).toContain("bin/mcp-sidecar");

    const buildSidecarSrc = fs.readFileSync(
      path.join(REPO_ROOT, "mcp-server/build_sidecar.py"),
      "utf-8"
    );
    expect(buildSidecarSrc).toContain("PyInstaller");
    expect(buildSidecarSrc).toContain("mcp-sidecar-x86_64-pc-windows-msvc.exe");

    const buildRsSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src-tauri/build.rs"),
      "utf-8"
    );
    expect(buildRsSrc).toContain("build_sidecar.py");
    expect(buildRsSrc).toContain("tauri_build::build()");
  });
});
