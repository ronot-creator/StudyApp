import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { clearAiPartitionSessionData } from "../src/components/settings/AiIntegrations";
import {
  checkForAppUpdatesSilently,
  popOutAiWebViewToFloatingWindow,
} from "../src/App";
import {
  handleReactDropzoneFiles,
  importFileWithNativeDialog,
  offloadPdfOcrToColabTunnel,
  purgeTemporaryRamBuffer,
} from "../src/services/ingestion/fileIngestion";
import {
  INTERNAL_FSRS_RATING_BUTTONS,
  mapInternalButtonToFsrsGrade,
  reviewCardInInternalStudyMode,
} from "../src/components/srs/InternalStudyMode";
import { DEFAULT_SEED_CARDS } from "../src/lib/fsrs";
import {
  buildSqlCipherPragmaStatement,
  initializeSqlCipherDatabase,
  lastAppliedSqlCipherPragma,
} from "../src/lib/db";
import {
  getOrCreateSqlCipherMasterKey,
  STRONGHOLD_SQLCIPHER_MASTER_KEY_RECORD,
} from "../src/services/strongholdKeystore";
import {
  createMindMapHistoryManager,
  exportMindMapCanvasToPng,
} from "../src/components/mindmap/MindMapCanvas";
import {
  getPdfDarkModeCanvasFilter,
  PDF_DARK_MODE_CSS_FILTER,
} from "../src/components/vault/VaultReader";

vi.mock("tesseract.js", () => ({
  default: {
    createWorker: vi.fn(async (lang: string) => ({
      recognize: async () => ({
        data: {
          text: `OCR transcript (${lang})`,
          confidence: 96.0,
        },
      }),
      terminate: async () => {},
    })),
    recognize: vi.fn(async (_img: unknown, lang: string) => ({
      data: {
        text: `OCR transcript (${lang})`,
        confidence: 96.0,
      },
    })),
  },
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: ({ data }: { data: Uint8Array }) => ({
    promise: Promise.resolve({
      numPages: 1,
      cleanup: vi.fn(async () => {}),
      getPage: async () => ({
        cleanup: vi.fn(async () => {}),
        getTextContent: async () => ({
          items: [{ str: new TextDecoder("utf-8").decode(data) }],
        }),
      }),
    }),
  }),
}));

const REPO_ROOT = path.resolve(__dirname, "..");

describe("Phase 16 Consumer Polish & Independence Verification Suite", () => {
  it("Step 1 (WEBVIEW_UX_AND_LIFECYCLE): injects Mobile Safari userAgent, detaches WebViews via Pop Out, and purges persist:ai_* partitions via Clear Data / Sign Out", async () => {
    const tauriConf = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf-8")
    );
    expect(tauriConf.app.windows[0].userAgent).toContain("iPhone");
    expect(tauriConf.app.windows[0].userAgent).toContain("Safari");

    const libRs = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf-8");
    expect(libRs).toContain("pub const MOBILE_SAFARI_USER_AGENT");
    expect(libRs).toContain(".user_agent(MOBILE_SAFARI_USER_AGENT)");
    expect(libRs).toContain("fn purge_ai_partition");

    const mockInvoke = vi.fn(async (cmd: string, args?: any) => ({
      status: "purged",
      provider: args?.provider,
      partition: `persist:ai_${args?.provider}`,
      purged_dir: `$APPLOCALDATA/.webview_partitions/persist_ai_${args?.provider}`,
      cmd,
    }));

    await popOutAiWebViewToFloatingWindow(
      "claude",
      "https://claude.ai/new",
      mockInvoke as any
    );
    expect(mockInvoke).toHaveBeenCalledWith("detach_ai_panel", {
      provider: "claude",
      targetUrl: "https://claude.ai/new",
    });

    const cleared = await clearAiPartitionSessionData("chatgpt", mockInvoke as any);
    expect(cleared.partition).toBe("persist:ai_chatgpt");
    expect(cleared.status).toBe("purged");
  });

  it("Step 2 (STREAM_AND_DISCARD_INGESTION): streams PDF in RAM and zero-fills buffer after Vault write, imports via dialog.open(), and offloads OCR to Colab tunnel", async () => {
    const sampleBuf = new Uint8Array([10, 20, 30, 40, 50]);
    let purgedLen = 0;
    await purgeTemporaryRamBuffer(sampleBuf, (len) => {
      purgedLen = len;
    });
    expect(purgedLen).toBe(5);
    expect(Array.from(sampleBuf)).toEqual([0, 0, 0, 0, 0]);

    const pdfFile = new File(
      [new TextEncoder().encode("Stream and discard renal physiology note")],
      "stream_note.pdf",
      { type: "application/pdf" }
    );
    let callbackZeroed = 0;
    const [droppedRes] = await handleReactDropzoneFiles([pdfFile], {
      targetVaultPrefix: "Renal",
      onRamBufferPurged: (n) => {
        callbackZeroed = n;
      },
    });
    expect(droppedRes.ramBufferPurged).toBe(true);
    expect(callbackZeroed).toBeGreaterThan(0);

    // Native dialog.open() import button pipeline
    const mockDialogOpen = vi.fn(async () => "C:\\Lectures\\imported_cardio.pdf");
    const importedRes = await importFileWithNativeDialog({
      targetVaultPrefix: "Cardiovascular",
      dialogOpenFn: mockDialogOpen as any,
    });
    expect(mockDialogOpen).toHaveBeenCalled();
    expect(importedRes?.ramBufferPurged).toBe(true);

    // Offload Heavy OCR to Colab toggle via HTTP POST
    const mockColabFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://colab-unit-test.ngrok-free.app/ocr_ingest");
      expect(init?.method).toBe("POST");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          markdown: "# Offloaded Colab OCR Transcript\n\nFrank-Starling ventricular curve.",
        }),
      };
    });

    const colabMd = await offloadPdfOcrToColabTunnel(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      "heavy_textbook.pdf",
      {
        colabTunnelUrl: "https://colab-unit-test.ngrok-free.app",
        fetchImpl: mockColabFetch as any,
      }
    );
    expect(colabMd).toContain("Frank-Starling ventricular curve");
  });

  it("Step 3 (INTERNAL_STUDY_MODE_AND_SQLCIPHER): grades cards locally with FSRS-5 (Again, Hard, Good, Easy) bypassing AnkiSyncWorker and initializes SQLCipher PRAGMA key from Stronghold", async () => {
    expect(INTERNAL_FSRS_RATING_BUTTONS.map((b) => b.label)).toEqual([
      "Again",
      "Hard",
      "Good",
      "Easy",
    ]);
    expect(mapInternalButtonToFsrsGrade("Again")).toBe(1);
    expect(mapInternalButtonToFsrsGrade("Hard")).toBe(2);
    expect(mapInternalButtonToFsrsGrade("Good")).toBe(3);
    expect(mapInternalButtonToFsrsGrade("Easy")).toBe(5);

    const sampleCard = { ...DEFAULT_SEED_CARDS[0] };
    const outcomeGood = await reviewCardInInternalStudyMode(sampleCard, "Good");
    expect(outcomeGood.updatedCard.reps).toBe(sampleCard.reps + 1);
    expect(outcomeGood.stabilityAfter).toBeGreaterThan(0);

    // Verify SQLCipher master key retrieval from Stronghold & PRAGMA key execution
    const masterKey = await getOrCreateSqlCipherMasterKey();
    expect(masterKey.length).toBeGreaterThanOrEqual(16);
    expect(STRONGHOLD_SQLCIPHER_MASTER_KEY_RECORD).toBe("sqlcipher_master_database_key_v1");

    const pragmaSql = buildSqlCipherPragmaStatement(masterKey);
    expect(pragmaSql).toContain("PRAGMA key =");
    expect(pragmaSql).toContain("PRAGMA cipher_memory_security = ON;");

    const initRes = await initializeSqlCipherDatabase();
    expect(initRes.encryptedAtRest).toBe(true);
    expect(initRes.masterKeyLoaded).toBe(true);
    expect(lastAppliedSqlCipherPragma).toContain("PRAGMA key =");
  });

  it("Step 4 (MINDMAP_EXPORT_AND_DARK_MODE_PDF): manages MindMap undo/redo history, exports PNG to $APPLOCALDATA/images, and applies dark-mode CSS filter to PDF.js", async () => {
    const history = createMindMapHistoryManager("State_1");
    expect(history.canUndo()).toBe(false);
    history.pushState("State_2");
    history.pushState("State_3");
    expect(history.canUndo()).toBe(true);
    expect(history.undo()).toBe("State_2");
    expect(history.canRedo()).toBe(true);
    expect(history.redo()).toBe("State_3");

    let savedPngPath = "";
    let savedBytesLen = 0;
    const pngExport = await exportMindMapCanvasToPng(null, "Renal", {
      timestampSecs: 1701234567,
      writeBinaryFn: async (dest, bytes) => {
        savedPngPath = dest;
        savedBytesLen = bytes.byteLength;
      },
    });
    expect(pngExport.filename).toBe("mindmap_Renal_1701234567.png");
    expect(savedPngPath).toContain("images");
    expect(savedPngPath).toContain("mindmap_Renal_1701234567.png");
    expect(savedBytesLen).toBeGreaterThan(0);

    // PDF Dark Mode CSS filter check
    expect(PDF_DARK_MODE_CSS_FILTER).toBe("invert(1) hue-rotate(180deg)");
    expect(getPdfDarkModeCanvasFilter("dark")).toBe("invert(1) hue-rotate(180deg)");
    expect(getPdfDarkModeCanvasFilter("light")).toBe("none");
  });

  it("Step 5 (TAURI_AUTO_UPDATER): configures GitHub Releases endpoint in tauri.conf.json and checks updates silently via @tauri-apps/plugin-updater", async () => {
    const tauriConf = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf-8")
    );
    expect(tauriConf.plugins?.updater?.active).toBe(true);
    expect(tauriConf.plugins?.updater?.endpoints?.[0]).toContain(
      "github.com/ronot-creator/StudyApp/releases"
    );

    const mockCheck = vi.fn(async () => ({
      available: true,
      version: "1.1.0",
      body: "Phase 16 Consumer Polish release",
    }));

    const upd = await checkForAppUpdatesSilently({ checkImpl: mockCheck as any });
    expect(upd.updateAvailable).toBe(true);
    expect(upd.version).toBe("1.1.0");
  });
});
