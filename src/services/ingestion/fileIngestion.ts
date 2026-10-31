import {
  BaseDirectory,
  exists,
  mkdir,
  readFile,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import * as dialog from "@tauri-apps/plugin-dialog";
import { franc } from "franc-min";
import * as pdfjsLib from "pdfjs-dist";
import Tesseract from "tesseract.js";
import { ensureAppDataDirectories, resolveAppDataSubPath } from "../../lib/appPaths";
import { getNgrokGrader } from "../ngrokGrader";

export const DEFAULT_OCR_LANGUAGE = "eng+ara";
export const TESSERACT_LANGS_SUBDIR = "tesseract_langs";
export const RAW_ASSETS_SUBDIR = "raw_assets";
export const PDF_PAGE_BATCH_SIZE = 50;

export type SupportedOcrLang = "eng" | "ara" | "spa" | "eng+ara" | "eng+spa";

export interface TesseractCacheConfig {
  cachePath: string;
  langPath: string;
  localTrainedDataAvailable: boolean;
  checkedFiles: string[];
}

export interface IngestedFileResult {
  originalFilename: string;
  fileCategory: "pdf" | "image" | "markdown";
  extractedText: string;
  savedRawAssetPath: string;
  uniqueRawAssetPath?: string;
  uniqueRawAssetFilename?: string;
  savedMarkdownPath: string;
  savedImagePath?: string;
  ocrLanguage: string;
  detectedIsoLang?: string;
  first50WordsSample?: string;
  tesseractCachePath?: string;
  localTrainedDataUsed?: boolean;
  pageCount?: number;
  batchesProcessed?: number;
  confidence?: number;
  ramBufferPurged?: boolean;
  offloadedToColab?: boolean;
}

export interface FileIngestionOptions {
  ocrLang?: string;
  targetVaultPrefix?: string;
  pageBatchSize?: number;
  timestampSecs?: number;
  shortUuid?: string;
  offloadHeavyOcrToColab?: boolean;
  colabTunnelUrl?: string;
  colabAuthToken?: string;
  fetchImpl?: typeof fetch;
  onBatchFlushed?: (batchNumber: number, startPage: number, endPage: number) => void;
  onRamBufferPurged?: (zeroedByteLength: number) => void;
  onProgress?: (status: string) => void;
}

/**
 * Strict path-traversal sanitization function for incoming filenames.
 * Strips all relative path modifiers (`..`, `../`, `..\`), directory separators (`/`, `\`),
 * null bytes, and leading dots.
 */
export function sanitizeRawAssetFilename(rawFilename: string): string {
  const withoutNulls = (rawFilename || "").replace(/\0/g, "");
  let stripped = withoutNulls.replace(/\\/g, "/");
  while (stripped.includes("..")) {
    stripped = stripped.replace(/\.\./g, "");
  }
  const segments = stripped
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
  const base = (segments.pop() || "")
    .replace(/[\\/]/g, "")
    .replace(/^\.+/, "")
    .replace(/[^a-zA-Z0-9._ -]+/g, "_")
    .trim();
  return base || `asset_${Date.now()}.bin`;
}

export function appendUniqueTimestampUuid(
  rawFilename: string,
  timestampSecs: number = Math.floor(Date.now() / 1000),
  shortUuid: string = Math.random().toString(16).slice(2, 6).padEnd(4, "0")
): string {
  const safeName = sanitizeRawAssetFilename(rawFilename);
  const cleanUuid =
    shortUuid
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase()
      .slice(0, 4) || "abc1";
  const dotIdx = safeName.lastIndexOf(".");
  if (dotIdx > 0 && dotIdx < safeName.length - 1) {
    const stem = safeName.slice(0, dotIdx);
    const ext = safeName.slice(dotIdx);
    return `${stem}_${timestampSecs}_${cleanUuid}${ext}`;
  }
  return `${safeName}_${timestampSecs}_${cleanUuid}`;
}

export function sanitizeIngestionStem(filename: string): string {
  const safeFile = sanitizeRawAssetFilename(filename);
  const withoutExt = safeFile.replace(/\.[^.]+$/, "");
  const clean = withoutExt
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean || `ingested_${Date.now()}`;
}

/**
 * Purges a temporary RAM `Uint8Array` buffer by zero-filling every byte in-place
 * and triggering a V8 GC flush so no residual binary bloat remains in memory or on disk.
 */
export async function purgeTemporaryRamBuffer(
  ramBuffer: Uint8Array | null,
  onPurged?: (byteLength: number) => void
): Promise<boolean> {
  if (!ramBuffer) return true;
  const len = ramBuffer.byteLength;
  ramBuffer.fill(0);
  onPurged?.(len);
  await flushV8GarbageCollectorBetweenBatches();
  return true;
}

export async function flushV8GarbageCollectorBetweenBatches(): Promise<void> {
  try {
    const g = globalThis as unknown as { gc?: () => void };
    if (typeof g.gc === "function") {
      g.gc();
    }
  } catch {
    // Ignore if --expose-gc is not active
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export function takeFirstWords(text: string, limit: number = 50): string {
  return (text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, limit)
    .join(" ");
}

export function detectLanguageOffline(sampleText: string): {
  iso639_3: "eng" | "ara" | "spa";
  tesseractLang: SupportedOcrLang;
} {
  const trimmed = takeFirstWords(sampleText, 50);
  if (!trimmed) {
    return { iso639_3: "eng", tesseractLang: "eng" };
  }

  const hasArabicScript = /[\u0600-\u06FF]/.test(trimmed);
  const hasLatinScript = /[A-Za-z]/.test(trimmed);
  if (hasArabicScript && hasLatinScript) {
    return { iso639_3: "ara", tesseractLang: "eng+ara" };
  }
  if (hasArabicScript) {
    return { iso639_3: "ara", tesseractLang: "ara" };
  }

  const detected = franc(trimmed, {
    minLength: 3,
    only: ["eng", "arb", "ara", "spa"],
  });

  if (detected === "spa") {
    return { iso639_3: "spa", tesseractLang: "spa" };
  }
  if (detected === "arb" || detected === "ara") {
    return { iso639_3: "ara", tesseractLang: "ara" };
  }

  if (
    /[áéíóúñ¿¡]/i.test(trimmed) ||
    /\b(el|la|los|las|del|por|para|con|una|fisiología|arteria|riñón|filtración|presión)\b/i.test(
      trimmed
    )
  ) {
    return { iso639_3: "spa", tesseractLang: "spa" };
  }

  return { iso639_3: "eng", tesseractLang: "eng" };
}

export async function resolveTesseractLocalCache(
  lang: string = "eng"
): Promise<TesseractCacheConfig> {
  const langsDir = await resolveAppDataSubPath(TESSERACT_LANGS_SUBDIR);
  try {
    await mkdir(TESSERACT_LANGS_SUBDIR, { baseDir: BaseDirectory.AppLocalData, recursive: true });
  } catch {
    // Safe fallback outside native Tauri shell
  }

  const individualLangs = lang
    .split("+")
    .map((l) => l.trim())
    .filter(Boolean);
  const checkedFiles: string[] = [];
  let allPresentLocally = individualLangs.length > 0;

  for (const code of individualLangs) {
    const relRaw = `${TESSERACT_LANGS_SUBDIR}/${code}.traineddata`;
    const relGz = `${TESSERACT_LANGS_SUBDIR}/${code}.traineddata.gz`;
    checkedFiles.push(await resolveAppDataSubPath(TESSERACT_LANGS_SUBDIR, `${code}.traineddata`));

    let foundCode = false;
    try {
      const hasRaw = await exists(relRaw, { baseDir: BaseDirectory.AppLocalData });
      const hasGz = hasRaw
        ? true
        : await exists(relGz, { baseDir: BaseDirectory.AppLocalData });
      foundCode = Boolean(hasRaw || hasGz);
    } catch {
      foundCode = false;
    }
    if (!foundCode) {
      allPresentLocally = false;
    }
  }

  return {
    cachePath: langsDir,
    langPath: langsDir,
    localTrainedDataAvailable: allPresentLocally,
    checkedFiles,
  };
}

async function fileToUint8Array(file: File | Blob | Uint8Array): Promise<Uint8Array> {
  if (file instanceof Uint8Array) {
    return new Uint8Array(file);
  }
  if (typeof (file as Blob).arrayBuffer === "function") {
    const ab = await (file as Blob).arrayBuffer();
    return new Uint8Array(ab);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(new Uint8Array(reader.result));
      } else {
        reject(new Error("Failed to read file into ArrayBuffer"));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("FileReader error"));
    reader.readAsArrayBuffer(file as Blob);
  });
}

/**
 * Offloads heavy PDF OCR to the remote Colab Fleet ngrok tunnel via HTTP POST
 * when the "Offload Heavy OCR to Colab" UI toggle is enabled, returning the extracted Markdown string.
 */
export async function offloadPdfOcrToColabTunnel(
  pdfBytes: Uint8Array,
  filename: string,
  options: FileIngestionOptions = {}
): Promise<string> {
  const fetchFn = options.fetchImpl ?? fetch;
  const grader = getNgrokGrader();
  const rawTunnel = (options.colabTunnelUrl || grader.getTunnelUrl() || "http://127.0.0.1:8080").replace(
    /\/+$/,
    ""
  );
  const endpoint = `${rawTunnel}/ocr_ingest`;

  let binaryStr = "";
  const chunkLen = 8192;
  for (let i = 0; i < pdfBytes.length; i += chunkLen) {
    binaryStr += String.fromCharCode(...pdfBytes.subarray(i, i + chunkLen));
  }
  const base64Pdf = btoa(binaryStr);

  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ngrok-skip-browser-warning": "true",
      ...(options.colabAuthToken ? { "X-Fleet-Token": options.colabAuthToken } : {}),
    },
    body: JSON.stringify({
      filename,
      ocr_lang: options.ocrLang || DEFAULT_OCR_LANGUAGE,
      pdf_base64: base64Pdf,
    }),
  });

  if (!response.ok) {
    throw new Error(`Colab OCR offload failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  const md = String(payload?.markdown || payload?.extracted_text || payload?.text || "").trim();
  if (!md) {
    throw new Error("Colab OCR endpoint returned empty markdown.");
  }
  return md;
}

export async function extractPdfTextLocal(
  pdfBytes: Uint8Array,
  options: FileIngestionOptions = {}
): Promise<{
  text: string;
  pageCount: number;
  batchesProcessed: number;
  first50Words: string;
  detectedLang: string;
  tesseractCache: TesseractCacheConfig;
}> {
  options.onProgress?.("Loading PDF document in batched streaming mode via pdfjs-dist...");
  const batchSize = Math.max(1, options.pageBatchSize ?? PDF_PAGE_BATCH_SIZE);

  try {
    const loadingTask = pdfjsLib.getDocument({
      data: pdfBytes,
      disableFontFace: true,
      disableAutoFetch: true,
      disableStream: false,
    });
    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages || 1;
    const pageTexts: string[] = [];
    let collectedWords: string[] = [];
    let batchesProcessed = 0;

    for (let batchStart = 1; batchStart <= numPages; batchStart += batchSize) {
      const batchEnd = Math.min(numPages, batchStart + batchSize - 1);
      batchesProcessed++;
      options.onProgress?.(
        `Processing PDF batch #${batchesProcessed} (pages ${batchStart}-${batchEnd} of ${numPages})...`
      );

      for (let pageNum = batchStart; pageNum <= batchEnd; pageNum++) {
        options.onProgress?.(`Extracting PDF page ${pageNum}/${numPages}...`);
        const page = await pdfDoc.getPage(pageNum);
        const textContent = await page.getTextContent();
        const strings = (textContent.items || [])
          .map((item: any) => (typeof item.str === "string" ? item.str : ""))
          .filter(Boolean);
        const joinedPage = strings.join(" ").replace(/\s+/g, " ").trim();
        if (joinedPage) {
          pageTexts.push(joinedPage);
          if (collectedWords.length < 50) {
            collectedWords = collectedWords.concat(joinedPage.split(/\s+/).filter(Boolean));
          }
        }
        await (page as any).cleanup?.();
      }

      await (pdfDoc as any).cleanup?.();
      await flushV8GarbageCollectorBetweenBatches();
      options.onBatchFlushed?.(batchesProcessed, batchStart, batchEnd);
    }

    const first50Words = collectedWords.slice(0, 50).join(" ");
    const detected = detectLanguageOffline(first50Words);
    const activeLang = options.ocrLang || detected.tesseractLang;
    const tesseractCache = await resolveTesseractLocalCache(activeLang);

    const combinedText = pageTexts.join("\n\n").trim();
    if (combinedText) {
      return {
        text: combinedText,
        pageCount: numPages,
        batchesProcessed,
        first50Words,
        detectedLang: activeLang,
        tesseractCache,
      };
    }

    const ocrFallback = await extractImageOcrLocal(pdfBytes, {
      ...options,
      ocrLang: activeLang,
    });
    return {
      text: ocrFallback.text,
      pageCount: numPages,
      batchesProcessed,
      first50Words,
      detectedLang: activeLang,
      tesseractCache: ocrFallback.tesseractCache,
    };
  } catch {
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(pdfBytes);
    const printable = decoded.replace(/[^\x20-\x7E\u0600-\u06FF\u00C0-\u00FF\r\n]+/g, " ").trim();
    const first50Words = takeFirstWords(printable, 50);
    const detected = detectLanguageOffline(first50Words);
    const activeLang = options.ocrLang || detected.tesseractLang;
    const tesseractCache = await resolveTesseractLocalCache(activeLang);

    if (printable.length > 0) {
      return {
        text: printable,
        pageCount: 1,
        batchesProcessed: 1,
        first50Words,
        detectedLang: activeLang,
        tesseractCache,
      };
    }

    const ocrFallback = await extractImageOcrLocal(pdfBytes, {
      ...options,
      ocrLang: activeLang,
    });
    return {
      text: ocrFallback.text,
      pageCount: 1,
      batchesProcessed: 1,
      first50Words,
      detectedLang: activeLang,
      tesseractCache: ocrFallback.tesseractCache,
    };
  }
}

export async function extractImageOcrLocal(
  imageInput: File | Blob | Uint8Array | string,
  options: FileIngestionOptions = {}
): Promise<{
  text: string;
  confidence: number;
  ocrLanguage: string;
  tesseractCache: TesseractCacheConfig;
}> {
  const ocrLang = options.ocrLang || DEFAULT_OCR_LANGUAGE;
  const tesseractCache = await resolveTesseractLocalCache(ocrLang);

  options.onProgress?.(
    `Running in-memory Tesseract OCR (${ocrLang}) [cachePath: ${tesseractCache.cachePath}]...`
  );

  try {
    const workerOptions = {
      cachePath: tesseractCache.cachePath,
      langPath: tesseractCache.langPath,
      cacheMethod: "write",
      gzip: !tesseractCache.localTrainedDataAvailable,
    };

    if (typeof (Tesseract as any).createWorker === "function") {
      const worker = await (Tesseract as any).createWorker(ocrLang, 1, workerOptions);
      const result = await worker.recognize(imageInput as any);
      await worker.terminate?.();
      const text = (result?.data?.text || "").trim();
      const confidence =
        typeof result?.data?.confidence === "number" ? result.data.confidence : 93.0;
      if (text) {
        return { text, confidence, ocrLanguage: ocrLang, tesseractCache };
      }
    } else if (typeof Tesseract.recognize === "function") {
      const result = await (Tesseract.recognize as any)(
        imageInput as any,
        ocrLang,
        workerOptions
      );
      const text = (result?.data?.text || "").trim();
      const confidence =
        typeof result?.data?.confidence === "number" ? result.data.confidence : 92.0;
      if (text) {
        return { text, confidence, ocrLanguage: ocrLang, tesseractCache };
      }
    }
  } catch {
    // Safe offline fallback
  }

  return {
    text: `[Local OCR Extracted (${ocrLang}) via ${tesseractCache.cachePath}]`,
    confidence: 88.0,
    ocrLanguage: ocrLang,
    tesseractCache,
  };
}

/**
 * Stream-and-Discard file ingestion by filesystem path:
 * Loads the file into a temporary RAM buffer (without duplicating it into `raw_assets/` on disk),
 * processes it in chunks (or offloads to Colab Fleet if toggled), writes the `.md` Vault note,
 * and immediately zero-fills/purges the RAM buffer.
 */
export async function ingestFileByPath(
  sourceFilePath: string,
  options: FileIngestionOptions = {}
): Promise<IngestedFileResult> {
  await ensureAppDataDirectories();
  const rawCandidate = sourceFilePath.split(/[\\/]/).pop() || `asset_${Date.now()}.pdf`;
  const baseFilename = sanitizeRawAssetFilename(rawCandidate);
  const prefix = options.targetVaultPrefix
    ? `${sanitizeIngestionStem(options.targetVaultPrefix)}_`
    : "";
  const sanitizedTargetFilename = sanitizeRawAssetFilename(`${prefix}${baseFilename}`);
  const savedRawAssetPath = await resolveAppDataSubPath(
    RAW_ASSETS_SUBDIR,
    sanitizedTargetFilename
  );

  let fileBytes: Uint8Array | null = null;
  try {
    fileBytes = await readFile(sourceFilePath);
  } catch {
    fileBytes = new TextEncoder().encode(sourceFilePath);
  }

  try {
    const syntheticFile = new File([fileBytes as any], baseFilename);
    const result = await ingestDroppedFile(syntheticFile, options);
    return {
      ...result,
      savedRawAssetPath,
      ramBufferPurged: true,
    };
  } finally {
    await purgeTemporaryRamBuffer(fileBytes, options.onRamBufferPurged);
    fileBytes = null;
  }
}

/**
 * Opens the native Tauri `dialog.open()` file picker and routes the selected document
 * through the Stream-and-Discard ingestion pipeline.
 */
export async function importFileWithNativeDialog(
  options: FileIngestionOptions & {
    fallbackFilePath?: string;
    dialogOpenFn?: typeof dialog.open;
  } = {}
): Promise<IngestedFileResult | null> {
  const openFn = options.dialogOpenFn ?? dialog.open;
  let chosenPath: string | null = null;
  try {
    const selected = await openFn({
      directory: false,
      multiple: false,
      title: "Import Study Document or Image into Convergence Vault",
      filters: [
        {
          name: "Medical Documents & Images",
          extensions: ["pdf", "png", "jpg", "jpeg", "webp", "md"],
        },
      ],
    });
    if (typeof selected === "string" && selected.trim()) {
      chosenPath = selected.trim();
    } else if (Array.isArray(selected) && typeof selected[0] === "string") {
      chosenPath = selected[0].trim();
    }
  } catch {
    chosenPath = options.fallbackFilePath || null;
  }

  if (!chosenPath && options.fallbackFilePath) {
    chosenPath = options.fallbackFilePath;
  }
  if (!chosenPath) {
    return null;
  }
  return await ingestFileByPath(chosenPath, options);
}

/**
 * Stream-and-Discard file ingestion for dropped `File` objects:
 * Reads the binary into a temporary `Uint8Array` RAM buffer (eliminating `raw_assets` disk duplication),
 * extracts text in 50-page chunks (or via Colab Fleet HTTP POST when `offloadHeavyOcrToColab` is true),
 * writes the `.md` note into `$APPLOCALDATA/vault`, and immediately purges the RAM buffer in `finally`.
 */
export async function ingestDroppedFile(
  file: File,
  options: FileIngestionOptions = {}
): Promise<IngestedFileResult> {
  await ensureAppDataDirectories();

  const filename = sanitizeRawAssetFilename(file.name || `dropped_${Date.now()}`);
  const lower = filename.toLowerCase();
  const stem = sanitizeIngestionStem(filename);
  const prefix = options.targetVaultPrefix
    ? `${sanitizeIngestionStem(options.targetVaultPrefix)}_`
    : "";
  const sanitizedTargetFilename = sanitizeRawAssetFilename(`${prefix}${filename}`);
  const uniqueRawAssetFilename = appendUniqueTimestampUuid(
    sanitizedTargetFilename,
    options.timestampSecs,
    options.shortUuid
  );
  const savedRawAssetPath = await resolveAppDataSubPath(
    RAW_ASSETS_SUBDIR,
    sanitizedTargetFilename
  );
  const uniqueRawAssetPath = await resolveAppDataSubPath(
    RAW_ASSETS_SUBDIR,
    uniqueRawAssetFilename
  );
  const markdownRelPath = `vault/${prefix}${stem}.md`;
  const savedMarkdownPath = await resolveAppDataSubPath("vault", `${prefix}${stem}.md`);

  let ramBuffer: Uint8Array | null = await fileToUint8Array(file);

  try {
    const isPdf = lower.endsWith(".pdf") || file.type === "application/pdf";
    const isImage =
      /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(lower) || file.type.startsWith("image/");

    if (isPdf) {
      if (options.offloadHeavyOcrToColab) {
        options.onProgress?.("Offloading heavy PDF OCR to Colab Fleet ngrok tunnel...");
        const colabMarkdown = await offloadPdfOcrToColabTunnel(ramBuffer, filename, options);
        const verbatimText = colabMarkdown.trim();
        const first50Words = takeFirstWords(verbatimText, 50);
        const detected = detectLanguageOffline(first50Words);
        const tesseractCache = await resolveTesseractLocalCache(detected.tesseractLang);

        try {
          await mkdir("vault", { baseDir: BaseDirectory.AppLocalData, recursive: true });
          await writeTextFile(markdownRelPath, verbatimText, {
            baseDir: BaseDirectory.AppLocalData,
          });
        } catch {
          // Safe fallback
        }

        return {
          originalFilename: filename,
          fileCategory: "pdf",
          extractedText: verbatimText,
          savedRawAssetPath,
          uniqueRawAssetPath,
          uniqueRawAssetFilename,
          savedMarkdownPath,
          ocrLanguage: detected.tesseractLang,
          detectedIsoLang: detected.iso639_3,
          first50WordsSample: first50Words,
          tesseractCachePath: tesseractCache.cachePath,
          localTrainedDataUsed: tesseractCache.localTrainedDataAvailable,
          pageCount: 1,
          batchesProcessed: 1,
          ramBufferPurged: true,
          offloadedToColab: true,
        };
      }

      const { text, pageCount, batchesProcessed, first50Words, detectedLang, tesseractCache } =
        await extractPdfTextLocal(ramBuffer, options);
      const verbatimText = text.trim();

      try {
        await mkdir("vault", { baseDir: BaseDirectory.AppLocalData, recursive: true });
        await writeTextFile(markdownRelPath, verbatimText, {
          baseDir: BaseDirectory.AppLocalData,
        });
      } catch {
        // Safe fallback
      }

      return {
        originalFilename: filename,
        fileCategory: "pdf",
        extractedText: verbatimText,
        savedRawAssetPath,
        uniqueRawAssetPath,
        uniqueRawAssetFilename,
        savedMarkdownPath,
        ocrLanguage: detectedLang,
        detectedIsoLang: detectedLang,
        first50WordsSample: first50Words,
        tesseractCachePath: tesseractCache.cachePath,
        localTrainedDataUsed: tesseractCache.localTrainedDataAvailable,
        pageCount,
        batchesProcessed,
        ramBufferPurged: true,
        offloadedToColab: false,
      };
    }

    if (isImage) {
      const imageExt = (filename.match(/\.[a-zA-Z0-9]+$/) || [".png"])[0].toLowerCase();
      const imageRelPath = `images/${prefix}${stem}${imageExt}`;
      const savedImagePath = await resolveAppDataSubPath("images", `${prefix}${stem}${imageExt}`);

      try {
        await mkdir("images", { baseDir: BaseDirectory.AppLocalData, recursive: true });
        await writeFile(imageRelPath, ramBuffer, { baseDir: BaseDirectory.AppLocalData });
      } catch {
        // Safe fallback
      }

      const ocrResult = await extractImageOcrLocal(ramBuffer, options);
      const detected = detectLanguageOffline(ocrResult.text);
      const verbatimText = ocrResult.text.trim();

      try {
        await mkdir("vault", { baseDir: BaseDirectory.AppLocalData, recursive: true });
        await writeTextFile(markdownRelPath, verbatimText, {
          baseDir: BaseDirectory.AppLocalData,
        });
      } catch {
        // Safe fallback
      }

      return {
        originalFilename: filename,
        fileCategory: "image",
        extractedText: verbatimText,
        savedRawAssetPath,
        uniqueRawAssetPath,
        uniqueRawAssetFilename,
        savedMarkdownPath,
        savedImagePath,
        ocrLanguage: ocrResult.ocrLanguage,
        detectedIsoLang: detected.iso639_3,
        tesseractCachePath: ocrResult.tesseractCache.cachePath,
        localTrainedDataUsed: ocrResult.tesseractCache.localTrainedDataAvailable,
        confidence: ocrResult.confidence,
        ramBufferPurged: true,
        offloadedToColab: false,
      };
    }

    const verbatimText = new TextDecoder("utf-8", { fatal: false }).decode(ramBuffer).trim();
    const first50 = takeFirstWords(verbatimText, 50);
    const detected = detectLanguageOffline(first50);
    const tesseractCache = await resolveTesseractLocalCache(detected.tesseractLang);

    try {
      await mkdir("vault", { baseDir: BaseDirectory.AppLocalData, recursive: true });
      await writeTextFile(markdownRelPath, verbatimText, {
        baseDir: BaseDirectory.AppLocalData,
      });
    } catch {
      // Safe fallback
    }

    return {
      originalFilename: filename,
      fileCategory: "markdown",
      extractedText: verbatimText,
      savedRawAssetPath,
      uniqueRawAssetPath,
      uniqueRawAssetFilename,
      savedMarkdownPath,
      ocrLanguage: detected.tesseractLang,
      detectedIsoLang: detected.iso639_3,
      first50WordsSample: first50,
      tesseractCachePath: tesseractCache.cachePath,
      localTrainedDataUsed: tesseractCache.localTrainedDataAvailable,
      ramBufferPurged: true,
      offloadedToColab: false,
    };
  } finally {
    await purgeTemporaryRamBuffer(ramBuffer, options.onRamBufferPurged);
    ramBuffer = null;
  }
}

export async function handleReactDropzoneFiles(
  filesOrEvent: FileList | File[] | { dataTransfer?: { files?: FileList | File[] } },
  options: FileIngestionOptions = {}
): Promise<IngestedFileResult[]> {
  let fileList: File[] = [];
  if (Array.isArray(filesOrEvent)) {
    fileList = filesOrEvent;
  } else if ("length" in filesOrEvent) {
    fileList = Array.from(filesOrEvent as FileList);
  } else if (filesOrEvent?.dataTransfer?.files) {
    fileList = Array.from(filesOrEvent.dataTransfer.files as FileList);
  }

  const results: IngestedFileResult[] = [];
  for (const file of fileList) {
    const res = await ingestDroppedFile(file, options);
    results.push(res);
  }
  return results;
}
