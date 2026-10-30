import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  AVAILABLE_OCR_LANGUAGES,
  predownloadOcrTrainedData,
  recoverExistingVaultDirectory,
  runWizardScaffoldingSequence,
} from "../src/components/setup/FirstRunWizard";
import { clearCachedAppLocalDataRoot, setCustomStorageTargetDir } from "../src/lib/appPaths";
import {
  handleReactDropzoneFiles,
  ingestFileByPath,
  sanitizeRawAssetFilename,
} from "../src/services/ingestion/fileIngestion";
import {
  clearSrsSyncQueue,
  enqueueCardsIntoSrsSyncQueue,
  getSrsSyncQueueCount,
  getSrsSyncQueueRows,
  SRS_SYNC_QUEUE_DROP_OLDEST_COUNT,
  SRS_SYNC_QUEUE_LIMIT,
  SRS_SYNC_QUEUE_TABLE_DDL,
} from "../src/lib/db";
import {
  getAnkiQueueBannerState,
  pushFlashcardsToAnki,
} from "../src/services/ankiConnect";

vi.mock("tesseract.js", () => ({
  default: {
    createWorker: vi.fn(async (lang: string) => ({
      recognize: async () => ({
        data: {
          text: `OCR transcript (${lang})`,
          confidence: 96.5,
        },
      }),
      terminate: async () => {},
    })),
    recognize: vi.fn(async (_img: unknown, lang: string) => ({
      data: {
        text: `OCR transcript (${lang})`,
        confidence: 96.5,
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

describe("Phase 14 Security Audit, Sandbox Hardening & Resilience Suite", () => {
  beforeEach(async () => {
    await clearSrsSyncQueue();
  });

  it("Step 1 (WEBVIEW_IPC_LOCKDOWN): restricts persist:ai_* partitions to ONLY resolve_shorthand_query and denies fs, shell, and dialog plugins", () => {
    const capJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "src-tauri/capabilities/default.json"), "utf-8")
    );
    expect(capJson.profiles).toBeDefined();
    const aiProfile = capJson.profiles["persist:ai_*"];
    expect(aiProfile).toBeDefined();
    expect(aiProfile.allow).toContain("resolve_shorthand_query");
    expect(aiProfile.deny).toContain("fs:default");
    expect(aiProfile.deny).toContain("shell:default");
    expect(aiProfile.deny).toContain("dialog:default");

    const lockdownPath = path.join(REPO_ROOT, "src-tauri/capabilities/ai_webview_lockdown.json");
    expect(fs.existsSync(lockdownPath)).toBe(true);
    const lockdownJson = JSON.parse(fs.readFileSync(lockdownPath, "utf-8"));
    expect(lockdownJson.partitions).toContain("persist:ai_*");
    expect(lockdownJson.permissions).toEqual(["allow-resolve-shorthand-query"]);
    expect(lockdownJson.deny).toContain("fs:default");
    expect(lockdownJson.deny).toContain("shell:default");
    expect(lockdownJson.deny).toContain("dialog:default");

    const libRs = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf-8");
    expect(libRs).toContain("pub fn validate_shorthand_query_payload");
    expect(libRs).toContain(
      "Arbitrary file paths and traversal sequences are forbidden in resolve_shorthand_query"
    );
  });

  it("Step 2 (PATH_TRAVERSAL_SANITIZATION): strips relative modifiers and directory slashes from filenames in TypeScript and Rust before copying into raw_assets", async () => {
    const relUnix = ["..", "..", "parent_dir", "renal_lecture.pdf"].join("/");
    const relWin = ["..", "..", "folder", "cardio_diagram.png"].join("\\");
    expect(sanitizeRawAssetFilename(relUnix)).toBe("renal_lecture.pdf");
    expect(sanitizeRawAssetFilename(relWin)).toBe("cardio_diagram.png");

    const maliciousFile = new File(
      [new TextEncoder().encode("Glomerular filtration rate notes")],
      ["..", "..", "outside_escape.pdf"].join("/"),
      { type: "application/pdf" }
    );
    const [droppedRes] = await handleReactDropzoneFiles([maliciousFile], {
      targetVaultPrefix: "Renal",
    });
    expect(droppedRes.originalFilename).toBe("outside_escape.pdf");
    expect(droppedRes.savedRawAssetPath).not.toContain("..");
    expect(droppedRes.savedRawAssetPath).toContain("raw_assets");
    expect(droppedRes.savedRawAssetPath).toContain("Renal_outside_escape.pdf");

    const byPathRes = await ingestFileByPath(["C:", "Lectures", "..", "nephron_notes.pdf"].join("\\"), {
      targetVaultPrefix: "Renal",
    });
    expect(byPathRes.savedRawAssetPath).not.toContain("..");
    expect(byPathRes.savedRawAssetPath).toContain("Renal_nephron_notes.pdf");

    const libRs = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf-8");
    expect(libRs).toContain("pub fn sanitize_raw_asset_filename");
    expect(libRs).toContain("pub fn copy_to_raw_assets_sandboxed");
    expect(libRs).toContain("fn copy_ingested_raw_asset");
  });

  it("Step 3 (WIZARD_LANGUAGE_SELECTOR_AND_VAULT_RECOVERY): pre-downloads selected OCR .traineddata into tesseract_langs and recovers existing vault without overwriting data", async () => {
    expect(AVAILABLE_OCR_LANGUAGES.map((l) => l.code)).toEqual(["eng", "ara", "spa", "fra"]);

    const writtenFiles: string[] = [];
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([0x54, 0x45, 0x53, 0x53]).buffer,
    }));

    const downloaded = await predownloadOcrTrainedData(["eng", "ara", "spa"], {
      fetchImpl: mockFetch as any,
      writeBinaryFn: async (dest) => {
        writtenFiles.push(dest);
      },
    });

    expect(downloaded).toHaveLength(3);
    expect(writtenFiles.some((f) => f.includes("eng.traineddata"))).toBe(true);
    expect(writtenFiles.some((f) => f.includes("ara.traineddata"))).toBe(true);
    expect(writtenFiles.some((f) => f.includes("spa.traineddata"))).toBe(true);

    const store = createMemoryStorage();
    clearCachedAppLocalDataRoot();
    const scaffolded = await runWizardScaffoldingSequence(
      "D:\\Convergence",
      undefined,
      store,
      {
        selectedLanguages: ["eng", "ara", "fra"],
        fetchImpl: mockFetch as any,
        writeBinaryFn: async () => {},
      }
    );
    expect(scaffolded.downloadedTrainedData).toHaveLength(3);
    expect(scaffolded.selectedLanguages).toEqual(["eng", "ara", "fra"]);

    const failedRecovery = await recoverExistingVaultDirectory({
      pickDirFn: async () => "E:\\IncompleteFolder",
      checkDirExistsFn: async (p) => p.endsWith("vault"),
      storage: store,
    });
    expect(failedRecovery.recovered).toBe(false);
    expect(failedRecovery.error).toContain("images");

    const validRecovery = await recoverExistingVaultDirectory({
      pickDirFn: async () => "D:\\ExistingConvergence",
      checkDirExistsFn: async (p) => p.endsWith("vault") || p.endsWith("images"),
      storage: store,
    });
    expect(validRecovery.recovered).toBe(true);
    expect(validRecovery.configReconstructed).toBe(true);
    expect(validRecovery.configPayload?.customTargetDir).toBe("D:\\ExistingConvergence");

    await setCustomStorageTargetDir("", store);
    clearCachedAppLocalDataRoot();
  });

  it("Step 4 (ANKICONNECT_SQLITE_QUEUE): queues cards in srs_sync_queue when AnkiConnect is unreachable, evicts 2,500 oldest rows on overflow, and updates UI banner", async () => {
    expect(SRS_SYNC_QUEUE_TABLE_DDL).toContain("CREATE TABLE IF NOT EXISTS srs_sync_queue");
    expect(SRS_SYNC_QUEUE_LIMIT).toBe(5000);
    expect(SRS_SYNC_QUEUE_DROP_OLDEST_COUNT).toBe(2500);

    const failingFetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8765");
    });

    const syncRes = await pushFlashcardsToAnki(
      [
        {
          frontPrompt: "Role of macula densa in tubuloglomerular feedback?",
          markScheme: "Senses distal NaCl delivery and regulates afferent arteriolar tone.",
          cardType: "written",
          questionOrder: 2,
          organSystem: "Renal",
        },
      ],
      "Convergence",
      { fetchImpl: failingFetch as any }
    );

    expect(syncRes.queuedOffline).toBe(true);
    expect(syncRes.queuedCount).toBe(1);
    expect(await getSrsSyncQueueCount()).toBe(1);

    const bannerState = getAnkiQueueBannerState();
    expect(bannerState.queuedCount).toBe(1);
    expect(bannerState.bannerMessage).toContain("srs_sync_queue");

    await clearSrsSyncQueue();
    const bulkCards = Array.from({ length: 5005 }, (_, i) => ({
      id: `card_${String(i).padStart(5, "0")}`,
      frontPrompt: `Question #${i}`,
      created_at: new Date(1700000000000 + i * 1000).toISOString(),
    }));

    const bulkResult = await enqueueCardsIntoSrsSyncQueue(bulkCards, {
      maxRows: 5000,
      dropCount: 2500,
    });

    expect(bulkResult.evictedCount).toBe(2500);
    expect(bulkResult.totalQueued).toBe(2505);

    const remainingRows = await getSrsSyncQueueRows();
    expect(remainingRows).toHaveLength(2505);
    expect(remainingRows[0].id).toBe("card_02500");
  });
});
