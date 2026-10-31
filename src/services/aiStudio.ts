import { CANONICAL_ORGAN_SYSTEMS, OrganSystem } from "../types/study";
import {
  getSecretFromStrongholdCache,
  loadSecretFromStronghold,
  saveSecretToStronghold,
  setSecretInStrongholdCache,
  STRONGHOLD_AI_STUDIO_KEY_RECORD,
  STRONGHOLD_CUSTOM_API_KEY_PREFIX,
} from "./strongholdKeystore";

export const GEMMA_31B_MODEL_ID = "gemma-4-31b-it";
export const GOOGLE_AI_STUDIO_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
export const AI_STUDIO_KEY_STORAGE = "convergence_google_ai_studio_api_key";
export const DUAL_TUNNEL_CONFIG_STORAGE = "convergence_dual_tunnel_config_v1";

export const API_NOT_FOUND_CODE = "API_NOT_FOUND";
export const API_NOT_FOUND_EVENT = "convergence:api-not-found";
export const KILL_SPINNERS_EVENT = "convergence:kill-loading-spinners";

export class ApiNotFoundError extends Error {
  public readonly code = API_NOT_FOUND_CODE;

  constructor(message: string = "API_NOT_FOUND: Google AI Studio API key is missing.") {
    super(message);
    this.name = API_NOT_FOUND_CODE;
    Object.setPrototypeOf(this, ApiNotFoundError.prototype);
  }
}

export function triggerApiNotFoundGuardrail(reason?: string): never {
  const err = new ApiNotFoundError(
    reason || "API_NOT_FOUND: Google AI Studio (Gemma 4 31B IT) API key is empty."
  );
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(new CustomEvent(KILL_SPINNERS_EVENT));
      window.dispatchEvent(
        new CustomEvent(API_NOT_FOUND_EVENT, {
          detail: { code: API_NOT_FOUND_CODE, message: err.message },
        })
      );
    } catch {
      // Ignore in headless environments
    }
  }
  throw err;
}

export interface DualTunnelConfig {
  primaryEngine: string;
  secondaryEngine: "fastmcp-sidecar-and-colab-fleet";
  preferGemmaWhenKeyPresent: boolean;
  mcpSidecarUrl: string;
  colabFallbackUrl: string;
  selectedModel?: string;
}

export interface GemmaMindMapTriple {
  source_node: string;
  linking_phrase: string;
  target_node: string;
  is_cross_system_bridge: boolean;
  target_organ_system?: OrganSystem | string | null;
}

export interface GemmaFsrsCardPayload {
  frontPrompt: string;
  markScheme: string;
  cardType: "written" | "mcq" | "fill_in_gap";
  questionOrder: 1 | 2 | 3;
  organSystem: OrganSystem;
  mcqOptions?: string[];
  mcqCorrectIndex?: number;
}

export interface OmnibarCanvasMutationResponse {
  action: "connect" | "add_node" | "delete_node" | "rename_node" | "summarize";
  summary: string;
  triples: GemmaMindMapTriple[];
  removedNodeLabels?: string[];
  renamedNode?: { from: string; to: string };
  engineUsed: string;
}

export const DEFAULT_DUAL_TUNNEL_CONFIG: DualTunnelConfig = {
  primaryEngine: GEMMA_31B_MODEL_ID,
  secondaryEngine: "fastmcp-sidecar-and-colab-fleet",
  preferGemmaWhenKeyPresent: true,
  mcpSidecarUrl: "http://localhost:1420/mcp",
  colabFallbackUrl: "",
  selectedModel: GEMMA_31B_MODEL_ID,
};

/**
 * Reads the Google AI Studio API key from the AES-256 encrypted Stronghold vault
 * (bypassing `window.localStorage`). Supports an optional explicit mock `storage` object for isolated unit tests.
 */
export function getAiStudioApiKey(
  storage?: Pick<Storage, "getItem">
): string {
  if (storage && (typeof localStorage === "undefined" || storage !== localStorage)) {
    return (storage.getItem(AI_STUDIO_KEY_STORAGE) || "").trim();
  }
  return getSecretFromStrongholdCache(STRONGHOLD_AI_STUDIO_KEY_RECORD);
}

/**
 * Writes the Google AI Studio API key directly to the AES-256 encrypted Stronghold vault,
 * bypassing plaintext `window.localStorage`.
 */
export function setAiStudioApiKey(
  apiKey: string,
  storage?: Pick<Storage, "setItem" | "removeItem">
): void {
  const trimmed = apiKey.trim();
  if (storage && (typeof localStorage === "undefined" || storage !== localStorage)) {
    if (trimmed) {
      storage.setItem(AI_STUDIO_KEY_STORAGE, trimmed);
    } else {
      storage.removeItem(AI_STUDIO_KEY_STORAGE);
    }
  }
  setSecretInStrongholdCache(STRONGHOLD_AI_STUDIO_KEY_RECORD, trimmed);
}

export async function saveAiStudioApiKeyToStronghold(apiKey: string): Promise<void> {
  await saveSecretToStronghold(STRONGHOLD_AI_STUDIO_KEY_RECORD, apiKey);
}

export async function loadAiStudioApiKeyFromStronghold(): Promise<string> {
  return await loadSecretFromStronghold(STRONGHOLD_AI_STUDIO_KEY_RECORD);
}

export async function saveCustomProviderKeyToStronghold(
  providerId: string,
  apiKey: string
): Promise<void> {
  await saveSecretToStronghold(`${STRONGHOLD_CUSTOM_API_KEY_PREFIX}${providerId}`, apiKey);
}

export async function loadCustomProviderKeyFromStronghold(
  providerId: string
): Promise<string> {
  return await loadSecretFromStronghold(`${STRONGHOLD_CUSTOM_API_KEY_PREFIX}${providerId}`);
}

export function hasAiStudioApiKey(
  storage?: Pick<Storage, "getItem">
): boolean {
  return getAiStudioApiKey(storage).length > 0;
}

export function getDualTunnelConfig(
  storage?: Pick<Storage, "getItem">
): DualTunnelConfig {
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    const raw = s?.getItem(DUAL_TUNNEL_CONFIG_STORAGE);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_DUAL_TUNNEL_CONFIG,
        ...parsed,
      };
    }
  } catch {
    // Ignore
  }
  return { ...DEFAULT_DUAL_TUNNEL_CONFIG };
}

export function saveDualTunnelConfig(
  config: Partial<DualTunnelConfig>,
  storage?: Pick<Storage, "getItem" | "setItem">
): DualTunnelConfig {
  const merged: DualTunnelConfig = {
    ...getDualTunnelConfig(storage),
    ...config,
  };
  try {
    const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    s?.setItem(DUAL_TUNNEL_CONFIG_STORAGE, JSON.stringify(merged));
  } catch {
    // Ignore
  }
  return merged;
}

/**
 * Queries the provider's `/models` REST endpoint, parses the returned model list,
 * and auto-selects `gemma-4-31b-it` if present.
 */
export async function fetchAvailableModels(
  options: {
    baseUrl?: string;
    apiKey?: string;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<{ models: string[]; selectedModel: string }> {
  const fetchFn = options.fetchImpl ?? fetch;
  const apiKey = (options.apiKey ?? getAiStudioApiKey()).trim();
  const rawBase = (
    options.baseUrl || "https://generativelanguage.googleapis.com/v1beta"
  ).replace(/\/+$/, "");

  const modelsEndpoint = rawBase.endsWith("/models")
    ? rawBase
    : `${rawBase}/models`;
  const urlWithKey =
    apiKey && modelsEndpoint.includes("generativelanguage.googleapis.com")
      ? `${modelsEndpoint}?key=${encodeURIComponent(apiKey)}`
      : modelsEndpoint;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (apiKey && !modelsEndpoint.includes("generativelanguage.googleapis.com")) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetchFn(urlWithKey, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch /models (HTTP ${response.status})`);
  }

  const payload = await response.json();
  const rawEntries: Array<Record<string, any> | string> = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload)
        ? payload
        : [];

  const parsedModels: string[] = [];
  for (const item of rawEntries) {
    const rawId =
      typeof item === "string"
        ? item
        : String(item?.id || item?.name || item?.model || "").trim();
    const cleanId = rawId.replace(/^models\//i, "").trim();
    if (cleanId && !parsedModels.includes(cleanId)) {
      parsedModels.push(cleanId);
    }
  }

  if (parsedModels.length === 0) {
    parsedModels.push(GEMMA_31B_MODEL_ID);
  }

  const selectedModel = parsedModels.includes(GEMMA_31B_MODEL_ID)
    ? GEMMA_31B_MODEL_ID
    : parsedModels[0];

  return {
    models: parsedModels,
    selectedModel,
  };
}

export function parseStrictJsonResponse<T>(rawText: string): T {
  const cleaned = (rawText || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) {
      return JSON.parse(objMatch[0]) as T;
    }
    const arrMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      return JSON.parse(arrMatch[0]) as T;
    }
    throw new Error("Gemma 4 31B IT response did not contain valid JSON");
  }
}

export async function generateWithGemma31b(
  prompt: string,
  systemInstruction?: string,
  options: {
    apiKey?: string;
    modelId?: string;
    jsonMode?: boolean;
    temperature?: number;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<string> {
  const apiKey = (options.apiKey ?? getAiStudioApiKey()).trim();
  if (!apiKey) {
    triggerApiNotFoundGuardrail("API_NOT_FOUND: Google AI Studio API key is empty.");
  }

  const modelId = options.modelId || GEMMA_31B_MODEL_ID;
  const fetchFn = options.fetchImpl ?? fetch;
  const endpoint = `${GOOGLE_AI_STUDIO_BASE_URL}/${modelId}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  const bodyPayload: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: systemInstruction
              ? `${systemInstruction.trim()}\n\n${prompt.trim()}`
              : prompt.trim(),
          },
        ],
      },
    ],
    generationConfig: {
      temperature: options.temperature ?? 0.15,
      ...(options.jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  };

  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyPayload),
  });

  if (!response.ok) {
    throw new Error(`Google AI Studio (${modelId}) HTTP ${response.status}`);
  }

  const data = await response.json();
  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text || "")
      .join("") || "";
  if (!text.trim()) {
    throw new Error("Empty response from Google AI Studio (gemma-4-31b-it)");
  }
  return text.trim();
}

export async function extractMindMapTriplesWithGemma(
  markdownText: string,
  organSystem: OrganSystem,
  options: { apiKey?: string; fetchImpl?: typeof fetch } = {}
): Promise<GemmaMindMapTriple[]> {
  const systemPrompt = [
    "You are the Convergence Medical Reasoning Engine (Gemma 4 31B IT).",
    "Extract physiological flow relationships as strictly typed JSON concept-map triples.",
    "Each linking_phrase must be between 1 and 30 words.",
    'Return ONLY JSON matching: {"triples": [{"source_node": "...", "linking_phrase": "...", "target_node": "...", "is_cross_system_bridge": false, "target_organ_system": null}]}',
  ].join(" ");

  const rawText = await generateWithGemma31b(
    `Organ System: ${organSystem}\n\nNotes:\n${markdownText}`,
    systemPrompt,
    { ...options, jsonMode: true }
  );

  const parsed = parseStrictJsonResponse<{ triples?: Array<Record<string, any>> }>(rawText);
  const rawList = Array.isArray(parsed?.triples) ? parsed.triples : [];
  const out: GemmaMindMapTriple[] = [];

  for (const item of rawList) {
    const source = String(item.source_node || item.source || "").trim();
    const phrase = String(item.linking_phrase || "")
      .trim()
      .split(/\s+/)
      .slice(0, 30)
      .join(" ");
    let target = String(item.target_node || item.target || "").trim();
    let isBridge = Boolean(item.is_cross_system_bridge);
    let targetSys: OrganSystem | string | null = item.target_organ_system
      ? String(item.target_organ_system).trim()
      : null;

    if (target.includes("::")) {
      const [prefix, rest] = target.split("::", 2);
      isBridge = true;
      targetSys = prefix.trim();
      target = rest.trim();
    }

    if (!source || !phrase || !target || source.toLowerCase() === target.toLowerCase()) {
      continue;
    }

    out.push({
      source_node: source,
      linking_phrase: phrase,
      target_node: target,
      is_cross_system_bridge: isBridge,
      target_organ_system: targetSys,
    });
  }
  return out;
}

export async function generateFsrsCardsWithGemma(
  markdownText: string,
  organSystem: OrganSystem,
  count: number = 3,
  options: { apiKey?: string; fetchImpl?: typeof fetch } = {}
): Promise<GemmaFsrsCardPayload[]> {
  const systemPrompt = [
    "You are the Convergence FSRS-5 Medical Card Generator (Gemma 4 31B IT).",
    `Generate ${count} high-yield 2nd-order or 3rd-order physiological reasoning flashcards.`,
    'Return ONLY JSON matching: {"cards": [{"frontPrompt": "...", "markScheme": "...", "cardType": "written", "questionOrder": 2}]}',
  ].join(" ");

  const rawText = await generateWithGemma31b(
    `Organ System: ${organSystem}\n\nNotes:\n${markdownText}`,
    systemPrompt,
    { ...options, jsonMode: true }
  );

  const parsed = parseStrictJsonResponse<{ cards?: Array<Record<string, any>> }>(rawText);
  const rawCards = Array.isArray(parsed?.cards) ? parsed.cards : [];
  const outCards: GemmaFsrsCardPayload[] = [];

  for (const c of rawCards) {
    const frontPrompt = String(c.frontPrompt || c.front_prompt || "").trim();
    const markScheme = String(c.markScheme || c.mark_scheme || "").trim();
    if (!frontPrompt || !markScheme) continue;
    const orderNum = Number(c.questionOrder || c.question_order || 2);
    const questionOrder: 1 | 2 | 3 = orderNum === 3 ? 3 : orderNum === 1 ? 1 : 2;
    const cardType: "written" | "mcq" | "fill_in_gap" =
      c.cardType === "mcq" || c.cardType === "fill_in_gap" ? c.cardType : "written";

    outCards.push({
      frontPrompt,
      markScheme,
      cardType,
      questionOrder,
      organSystem,
      mcqOptions: Array.isArray(c.mcqOptions) ? c.mcqOptions.map(String) : undefined,
      mcqCorrectIndex: typeof c.mcqCorrectIndex === "number" ? c.mcqCorrectIndex : undefined,
    });
  }
  return outCards;
}

export function parseConnectCommandLocally(
  commandPrompt: string,
  activeSystem: OrganSystem = "Renal"
): OmnibarCanvasMutationResponse | null {
  const trimmed = commandPrompt.trim();

  const connectMatch = trimmed.match(
    /^connect\s+["'“”\[]?(.+?)["'“”\]]?\s+(?:to|->|→)\s+["'“”\[]?(.+?)["'“”\]]?(?:\s+(?:via|by|through|with|using|as)\s+["'“”]?(.+?)["'“”]?)?$/i
  );
  if (connectMatch) {
    const sourceNode = connectMatch[1].trim();
    const rawTarget = connectMatch[2].trim();
    const phrase = (connectMatch[3]?.trim() || "physiologically regulates and couples to")
      .split(/\s+/)
      .slice(0, 30)
      .join(" ");

    let isBridge = false;
    let targetSys: OrganSystem | string | null = null;
    let targetNode = rawTarget;
    if (rawTarget.includes("::")) {
      const [prefix, rest] = rawTarget.split("::", 2);
      const matched = CANONICAL_ORGAN_SYSTEMS.find(
        (s) => s.toLowerCase() === prefix.trim().toLowerCase()
      );
      isBridge = true;
      targetSys = matched || prefix.trim();
      targetNode = rest.trim();
    }

    return {
      action: "connect",
      summary: `Connected [${sourceNode}] --(${phrase})--> [${
        isBridge && targetSys ? `${targetSys}::${targetNode}` : targetNode
      }] in ${activeSystem}`,
      triples: [
        {
          source_node: sourceNode,
          linking_phrase: phrase,
          target_node: targetNode,
          is_cross_system_bridge: isBridge,
          target_organ_system: targetSys,
        },
      ],
      engineUsed: GEMMA_31B_MODEL_ID,
    };
  }

  return null;
}

export async function executeOmnibarCanvasCommand(
  commandPrompt: string,
  activeSystem: OrganSystem,
  currentMarkdown: string,
  options: { apiKey?: string; fetchImpl?: typeof fetch; enforceApiKeyGuardrail?: boolean } = {}
): Promise<OmnibarCanvasMutationResponse> {
  const apiKey = (options.apiKey ?? getAiStudioApiKey()).trim();
  if (!apiKey && options.enforceApiKeyGuardrail) {
    triggerApiNotFoundGuardrail(
      "API_NOT_FOUND: Google AI Studio API key is required for Gemma 31B Omnibar execution."
    );
  }

  const localFastMatch = parseConnectCommandLocally(commandPrompt, activeSystem);

  if (apiKey) {
    try {
      const systemPrompt = [
        "You are the Convergence Omnibar Canvas Manipulation Engine powered by Gemma 4 31B IT.",
        "Given a user command over MindMapCanvas.tsx, output a strictly typed JSON graph modification.",
        'Schema: {"action": "connect", "summary": "...", "triples": [{"source_node": "...", "linking_phrase": "...", "target_node": "...", "is_cross_system_bridge": false, "target_organ_system": null}]}',
      ].join(" ");

      const raw = await generateWithGemma31b(
        `Active Organ System: ${activeSystem}\nCommand: ${commandPrompt}\nCurrent Graph Markdown:\n${currentMarkdown.slice(
          0,
          2500
        )}`,
        systemPrompt,
        { ...options, apiKey, jsonMode: true }
      );
      const parsed = parseStrictJsonResponse<Partial<OmnibarCanvasMutationResponse>>(raw);
      if (Array.isArray(parsed.triples) && parsed.triples.length > 0) {
        return {
          action: parsed.action || "connect",
          summary:
            parsed.summary ||
            `Gemma 4 31B IT applied ${parsed.triples.length} graph modification(s) to ${activeSystem}`,
          triples: parsed.triples,
          removedNodeLabels: parsed.removedNodeLabels,
          renamedNode: parsed.renamedNode,
          engineUsed: GEMMA_31B_MODEL_ID,
        };
      }
    } catch {
      if (localFastMatch) {
        return localFastMatch;
      }
    }
  }

  if (localFastMatch) {
    return localFastMatch;
  }

  const cleanTopic = commandPrompt.replace(/^add\s+/i, "").trim() || `${activeSystem} Node`;
  return {
    action: "add_node",
    summary: `Added [${cleanTopic}] to ${activeSystem} Mind Map`,
    triples: [
      {
        source_node: `${activeSystem} Homeostasis`,
        linking_phrase: "coordinates physiological response through",
        target_node: cleanTopic,
        is_cross_system_bridge: false,
        target_organ_system: null,
      },
    ],
    engineUsed: apiKey ? GEMMA_31B_MODEL_ID : "local-deterministic-fallback",
  };
}

export const MAX_RETRIES = 3;
export const VERBATIM_EXTRACTION_FAILED_CODE = "VERBATIM_EXTRACTION_FAILED";
export const VERBATIM_EXTRACTION_FAILED_EVENT = "convergence:verbatim-extraction-failed";

export class VerbatimExtractionFailedError extends Error {
  public readonly code = VERBATIM_EXTRACTION_FAILED_CODE;
  public readonly attempts: number;

  constructor(
    message: string = "VERBATIM_EXTRACTION_FAILED: Gemma failed the word-count parity check 3 consecutive times.",
    attempts: number = MAX_RETRIES
  ) {
    super(message);
    this.name = VERBATIM_EXTRACTION_FAILED_CODE;
    this.attempts = attempts;
    Object.setPrototypeOf(this, VerbatimExtractionFailedError.prototype);
  }
}

export function countNonEmptyWords(text: string): number {
  return (text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function checkWordCountParity(
  sourceText: string,
  extractedText: string,
  minParityRatio: number = 0.85
): boolean {
  const sourceCount = countNonEmptyWords(sourceText);
  const extractedCount = countNonEmptyWords(extractedText);
  if (sourceCount === 0) return extractedCount === 0;
  if (extractedCount === 0) return false;
  const ratio = Math.min(sourceCount, extractedCount) / Math.max(sourceCount, extractedCount);
  return ratio >= minParityRatio;
}

/**
 * Runs Gemma 4 31B IT verbatim text extraction with a strict `MAX_RETRIES = 3` circuit breaker.
 * If Gemma fails the word-count parity check `3` consecutive times (e.g., due to corrupted/garbage OCR),
 * immediately kills the retry loop, alerts the user, and throws `VerbatimExtractionFailedError` (`VERBATIM_EXTRACTION_FAILED`)
 * to prevent infinite API quota burn.
 */
export async function extractVerbatimWithGemma(
  rawOcrText: string,
  options: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
    minParityRatio?: number;
    maxRetries?: number;
    onAlert?: (message: string) => void;
  } = {}
): Promise<{ text: string; attempts: number }> {
  const limit = Math.min(MAX_RETRIES, Math.max(1, options.maxRetries ?? MAX_RETRIES));
  const minParity = options.minParityRatio ?? 0.85;
  const systemPrompt = [
    "You are the Convergence Verbatim Medical Transcription Engine (Gemma 4 31B IT).",
    "Clean OCR layout artifacts while preserving 100% verbatim word-count parity with the input text.",
    "Do NOT summarize, truncate, or omit any words.",
  ].join(" ");

  for (let attempt = 1; attempt <= limit; attempt++) {
    const candidate = await generateWithGemma31b(
      rawOcrText,
      systemPrompt,
      {
        apiKey: options.apiKey,
        fetchImpl: options.fetchImpl,
        temperature: 0.0,
      }
    );

    if (checkWordCountParity(rawOcrText, candidate, minParity)) {
      return { text: candidate.trim(), attempts: attempt };
    }
  }

  const alertMsg = `${VERBATIM_EXTRACTION_FAILED_CODE}: Gemma failed word-count parity check ${limit} consecutive times. Circuit breaker tripped to protect daily API quota.`;
  options.onAlert?.(alertMsg);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
    try {
      window.dispatchEvent(
        new CustomEvent(VERBATIM_EXTRACTION_FAILED_EVENT, {
          detail: { code: VERBATIM_EXTRACTION_FAILED_CODE, attempts: limit, message: alertMsg },
        })
      );
    } catch {
      // Ignore in headless environment
    }
  }
  throw new VerbatimExtractionFailedError(alertMsg, limit);
}

