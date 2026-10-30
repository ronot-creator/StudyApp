import { SrsCard } from "../types/study";
import { GemmaFsrsCardPayload } from "./aiStudio";

export const ANKI_CONNECT_URL = "http://127.0.0.1:8765";
export const ANKI_CONNECT_VERSION = 6;
export const DEFAULT_CONVERGENCE_DECK = "Convergence";

export interface AnkiConnectRequestPayload {
  action: string;
  version: number;
  params?: Record<string, unknown>;
}

export interface AnkiConnectResponse<T = unknown> {
  result: T;
  error: string | null;
}

export interface AnkiNoteInput {
  deckName: string;
  modelName: string;
  fields: {
    Front: string;
    Back: string;
  };
  options?: {
    allowDuplicate?: boolean;
    duplicateScope?: string;
  };
  tags: string[];
}

export interface AnkiSyncSummary {
  deckName: string;
  deckId: number | null;
  totalSubmitted: number;
  addedNoteIds: Array<number | null>;
  succeededCount: number;
}

/**
 * Low-level AnkiConnect v6 JSON-RPC client targeting `http://127.0.0.1:8765`.
 */
export async function invokeAnkiConnect<T = unknown>(
  action: string,
  params?: Record<string, unknown>,
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<T> {
  const fetchFn = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint || ANKI_CONNECT_URL;

  const body: AnkiConnectRequestPayload = {
    action,
    version: ANKI_CONNECT_VERSION,
    ...(params ? { params } : {}),
  };

  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`AnkiConnect HTTP ${response.status} at ${endpoint}`);
  }

  const payload = (await response.json()) as AnkiConnectResponse<T>;
  if (payload.error) {
    throw new Error(`AnkiConnect error (${action}): ${payload.error}`);
  }
  return payload.result;
}

/**
 * Checks whether a local Anki Desktop instance with AnkiConnect (`http://127.0.0.1:8765`) is reachable.
 */
export async function checkAnkiConnectStatus(
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<{ connected: boolean; version?: number; endpoint: string; error?: string }> {
  const endpoint = options.endpoint || ANKI_CONNECT_URL;
  try {
    const version = await invokeAnkiConnect<number>("version", undefined, options);
    return {
      connected: true,
      version,
      endpoint,
    };
  } catch (err: any) {
    return {
      connected: false,
      endpoint,
      error: err?.message || "AnkiConnect unreachable at http://127.0.0.1:8765",
    };
  }
}

/**
 * Ensures the `"Convergence"` deck exists in Anki Desktop via `invoke: 'createDeck'`.
 */
export async function ensureConvergenceDeckExists(
  deckName: string = DEFAULT_CONVERGENCE_DECK,
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<number> {
  return await invokeAnkiConnect<number>(
    "createDeck",
    { deck: deckName },
    options
  );
}

/**
 * Pushes generated FSRS / Gemma JSON flashcards directly to Anki Desktop via `invoke: 'addNotes'`.
 */
export async function pushFlashcardsToAnki(
  cards: Array<SrsCard | GemmaFsrsCardPayload>,
  deckName: string = DEFAULT_CONVERGENCE_DECK,
  options: { endpoint?: string; fetchImpl?: typeof fetch } = {}
): Promise<AnkiSyncSummary> {
  if (!cards || cards.length === 0) {
    return {
      deckName,
      deckId: null,
      totalSubmitted: 0,
      addedNoteIds: [],
      succeededCount: 0,
    };
  }

  const deckId = await ensureConvergenceDeckExists(deckName, options);

  const notes: AnkiNoteInput[] = cards.map((card) => {
    const sysTag = String(card.organSystem || "General")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_");
    const orderTag = `order_${card.questionOrder || 2}`;
    const typeTag = `type_${card.cardType || "written"}`;

    let frontHtml = card.frontPrompt;
    if ("mcqOptions" in card && Array.isArray(card.mcqOptions) && card.mcqOptions.length > 0) {
      frontHtml +=
        "<br/><ol>" +
        card.mcqOptions.map((opt) => `<li>${opt}</li>`).join("") +
        "</ol>";
    } else if ("mcqOptionsJson" in card && card.mcqOptionsJson) {
      try {
        const parsedOpts = JSON.parse(card.mcqOptionsJson) as string[];
        if (Array.isArray(parsedOpts) && parsedOpts.length > 0) {
          frontHtml +=
            "<br/><ol>" + parsedOpts.map((opt) => `<li>${opt}</li>`).join("") + "</ol>";
        }
      } catch {
        // Ignore malformed MCQ options JSON
      }
    }

    return {
      deckName,
      modelName: "Basic",
      fields: {
        Front: frontHtml,
        Back: card.markScheme,
      },
      options: {
        allowDuplicate: false,
        duplicateScope: "deck",
      },
      tags: ["convergence", sysTag, orderTag, typeTag],
    };
  });

  const addedNoteIds = await invokeAnkiConnect<Array<number | null>>(
    "addNotes",
    { notes },
    options
  );

  const succeededCount = (addedNoteIds || []).filter((id) => typeof id === "number" && id > 0)
    .length;

  return {
    deckName,
    deckId,
    totalSubmitted: notes.length,
    addedNoteIds: addedNoteIds || [],
    succeededCount,
  };
}
