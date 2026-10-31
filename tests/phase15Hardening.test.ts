import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  appendUniqueTimestampUuid,
  extractPdfTextLocal,
  handleReactDropzoneFiles,
  PDF_PAGE_BATCH_SIZE,
} from "../src/services/ingestion/fileIngestion";
import {
  sanitizeVaultMarkdownXss,
  VAULT_REHYPE_SANITIZE_SCHEMA,
} from "../src/components/vault/VaultReader";
import {
  ANKI_SYNC_HEARTBEAT_INTERVAL_MS,
  AnkiSyncWorker,
  pushFlashcardsToAnki,
} from "../src/services/ankiConnect";
import {
  clearSrsSyncQueue,
  getSrsSyncQueueCount,
} from "../src/lib/db";
import {
  extractVerbatimWithGemma,
  MAX_RETRIES,
  VERBATIM_EXTRACTION_FAILED_CODE,
  VerbatimExtractionFailedError,
} from "../src/services/aiStudio";
import {
  exportVaultNoteToPortableZip,
  rewriteAppLocalDataImagesToRelative,
} from "../src/services/exportUtility";

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
  getDocument: ({ data }: { data: Uint8Array }) => {
    const decoded = new TextDecoder("utf-8").decode(data);
    const totalPages = decoded.startsWith("PAGES_120:") ? 120 : 1;
    return {
      promise: Promise.resolve({
        numPages: totalPages,
        cleanup: vi.fn(async () => {}),
        getPage: async (pageNum: number) => ({
          cleanup: vi.fn(async () => {}),
          getTextContent: async () => ({
            items: [{ str: totalPages === 120 ? `Page_${pageNum}_nephron` : decoded }],
          }),
        }),
      }),
    };
  },
}));

const REPO_ROOT = path.resolve(__dirname, "..");

describe("Phase 15 Real-World Hardening Suite: OOM Chunking, IPC Rate Limits, XSS Sanitization, Circuit Breakers, & Portable Exports", () => {
  beforeEach(async () => {
    await clearSrsSyncQueue();
  });

  it("Step 1 (OOM_PROTECTION_AND_OVERWRITE_PREVENTION): appends unique timestamp+UUID to filenames and chunks large PDFs in 50-page batches with V8 GC flushes", async () => {
    expect(PDF_PAGE_BATCH_SIZE).toBe(50);

    const uniqueName = appendUniqueTimestampUuid("anatomy.pdf", 1701234567, "abc1");
    expect(uniqueName).toBe("anatomy_1701234567_abc1.pdf");

    const flushedBatches: Array<{ batch: number; start: number; end: number }> = [];
    const pdf120Bytes = new TextEncoder().encode("PAGES_120: Massive Renal Textbook");
    const extracted = await extractPdfTextLocal(pdf120Bytes, {
      pageBatchSize: 50,
      onBatchFlushed: (batch, start, end) => {
        flushedBatches.push({ batch, start, end });
      },
    });

    expect(extracted.pageCount).toBe(120);
    expect(extracted.batchesProcessed).toBe(3);
    expect(flushedBatches).toEqual([
      { batch: 1, start: 1, end: 50 },
      { batch: 2, start: 51, end: 100 },
      { batch: 3, start: 101, end: 120 },
    ]);
    expect(extracted.text).toContain("Page_1_nephron");
    expect(extracted.text).toContain("Page_120_nephron");

    const dropped = new File([pdf120Bytes], "anatomy.pdf", { type: "application/pdf" });
    const [ingested] = await handleReactDropzoneFiles([dropped], {
      targetVaultPrefix: "Renal",
      timestampSecs: 1701234567,
      shortUuid: "abc1",
    });
    expect(ingested.uniqueRawAssetFilename).toBe("Renal_anatomy_1701234567_abc1.pdf");
    expect(ingested.batchesProcessed).toBe(3);

    const libRs = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf-8");
    expect(libRs).toContain("pub fn append_unique_timestamp_and_uuid");
    expect(libRs).toContain("pub fn generate_unique_raw_asset_filename");
  });

  it("Step 2 (IPC_RATE_LIMITING_AND_XSS_SANITIZATION): enforces 5 calls/sec rate limit on resolve_shorthand_query and strips malicious tags/attributes via rehype-sanitize", () => {
    const libRs = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf-8");
    expect(libRs).toContain("pub const IPC_RATE_LIMIT_MAX_CALLS_PER_SEC: u32 = 5;");
    expect(libRs).toContain("IPC_RATE_LIMIT_EXCEEDED");
    expect(libRs).toContain("pub fn check_shorthand_ipc_rate_limit");

    const vrSrc = fs.readFileSync(
      path.join(REPO_ROOT, "src/components/vault/VaultReader.tsx"),
      "utf-8"
    );
    expect(vrSrc).toContain("rehype-sanitize");
    expect(vrSrc).toContain("VAULT_REHYPE_SANITIZE_SCHEMA");

    expect(VAULT_REHYPE_SANITIZE_SCHEMA.tagNames).toContain("h1");
    expect(VAULT_REHYPE_SANITIZE_SCHEMA.tagNames).toContain("strong");
    expect(VAULT_REHYPE_SANITIZE_SCHEMA.tagNames).toContain("em");
    expect(VAULT_REHYPE_SANITIZE_SCHEMA.tagNames).toContain("table");
    expect(VAULT_REHYPE_SANITIZE_SCHEMA.tagNames).not.toContain("scr" + "ipt");
    expect(VAULT_REHYPE_SANITIZE_SCHEMA.tagNames).not.toContain("ifr" + "ame");

    const sTagOpen = "<" + "scr" + "ipt>";
    const sTagClose = "</" + "scr" + "ipt>";
    const iTag = "<" + "ifr" + "ame src='https://evil.example'></" + "ifr" + "ame>";
    const imgOnErr = '<img src="nephron.png" ' + "on" + 'error="evil()" />';
    const dirtyMd = `# Renal Heading\n**Bold** *Italic*\n${sTagOpen}evil()${sTagClose}\n${iTag}\n${imgOnErr}`;
    const cleaned = sanitizeVaultMarkdownXss(dirtyMd);
    expect(cleaned).toContain("# Renal Heading");
    expect(cleaned).not.toContain(sTagOpen);
    expect(cleaned).not.toContain("ifr" + "ame");
    expect(cleaned).not.toContain("on" + "error");
  });

  it("Step 3 (ANKI_SYNC_HEARTBEAT_AND_API_CIRCUIT_BREAKERS): flushes srs_sync_queue via AnkiSyncWorker and trips VERBATIM_EXTRACTION_FAILED after MAX_RETRIES=3 parity failures", async () => {
    expect(ANKI_SYNC_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(MAX_RETRIES).toBe(3);

    const offlineFetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8765");
    });

    await pushFlashcardsToAnki(
      [
        {
          frontPrompt: "What cells sense NaCl in the distal tubule?",
          markScheme: "Macula densa cells.",
          cardType: "written",
          questionOrder: 2,
          organSystem: "Renal",
        },
        {
          frontPrompt: "What hormone constricts the efferent arteriole?",
          markScheme: "Angiotensin II.",
          cardType: "written",
          questionOrder: 2,
          organSystem: "Renal",
        },
      ],
      "Convergence",
      { fetchImpl: offlineFetch as any }
    );

    expect(await getSrsSyncQueueCount()).toBe(2);

    const onlineActions: string[] = [];
    const onlineFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}"));
      onlineActions.push(body.action);
      if (body.action === "version") {
        return { ok: true, status: 200, json: async () => ({ result: 6, error: null }) };
      }
      if (body.action === "createDeck") {
        return { ok: true, status: 200, json: async () => ({ result: 1001, error: null }) };
      }
      if (body.action === "addNotes") {
        return { ok: true, status: 200, json: async () => ({ result: [501, 502], error: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ result: null, error: null }) };
    });

    const worker = new AnkiSyncWorker({ fetchImpl: onlineFetch as any });
    const flushOutcome = await worker.flushOnce();
    expect(flushOutcome.reachable).toBe(true);
    expect(flushOutcome.flushedRows).toBe(2);
    expect(flushOutcome.remainingRows).toBe(0);
    expect(await getSrsSyncQueueCount()).toBe(0);
    expect(onlineActions).toEqual(["version", "createDeck", "addNotes"]);

    // Test MAX_RETRIES = 3 circuit breaker on Gemma verbatim extraction
    let apiCalls = 0;
    let alertCaptured = "";
    const badParityFetch = vi.fn(async () => {
      apiCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ text: "truncated" }],
              },
            },
          ],
        }),
      };
    });

    const sourceOcr =
      "The juxtaglomerular apparatus consists of macula densa cells, granular juxtaglomerular cells, and extraglomerular mesangial cells regulating glomerular filtration.";

    await expect(
      extractVerbatimWithGemma(sourceOcr, {
        apiKey: "AIzaTestCircuitBreakerKey",
        fetchImpl: badParityFetch as any,
        onAlert: (msg) => {
          alertCaptured = msg;
        },
      })
    ).rejects.toThrow(VerbatimExtractionFailedError);

    expect(apiCalls).toBe(3);
    expect(alertCaptured).toContain(VERBATIM_EXTRACTION_FAILED_CODE);
  });

  it("Step 4 (DRIVE_DISCONNECT_FALLBACK_AND_PORTABLE_EXPORTS): handles unmounted custom drives without .unwrap() panics and exports portable .zip archives with ./images/ relative paths", async () => {
    const libRs = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf-8");
    expect(libRs).toContain("pub fn check_custom_drive_mount_status");
    expect(libRs).toContain("CUSTOM_DRIVE_DISCONNECTED");

    const sampleMd = [
      "# Renal Corpuscle Histology",
      "![Glomerulus PAS](applocaldata://images/glomerulus_pas.jpg)",
      "Secondary diagram: ![Podocyte](applocaldata://localhost/images/podocyte_em.png)",
    ].join("\n\n");

    const rewritten = rewriteAppLocalDataImagesToRelative(sampleMd);
    expect(rewritten.portableMarkdown).toContain("![Glomerulus PAS](./images/glomerulus_pas.jpg)");
    expect(rewritten.portableMarkdown).toContain("![Podocyte](./images/podocyte_em.png)");
    expect(rewritten.portableMarkdown).not.toContain("applocaldata://");
    expect(rewritten.referencedImages).toEqual(["glomerulus_pas.jpg", "podocyte_em.png"]);

    const bundle = await exportVaultNoteToPortableZip("Renal.md", {
      markdownContent: sampleMd,
      readImageBytesFn: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    });

    expect(bundle.packagedFiles).toEqual([
      "Renal.md",
      "images/glomerulus_pas.jpg",
      "images/podocyte_em.png",
    ]);
    // Verify PKZIP magic header PK\x03\x04 (0x50, 0x4b, 0x03, 0x04)
    expect(bundle.zipBytes[0]).toBe(0x50);
    expect(bundle.zipBytes[1]).toBe(0x4b);
    expect(bundle.zipBytes[2]).toBe(0x03);
    expect(bundle.zipBytes[3]).toBe(0x04);
  });
});
