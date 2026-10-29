import Database from "@tauri-apps/plugin-sql";
import { AiProviderConfig } from "../types/study";
import { SQLITE_DB_URI } from "./ngrokGrader";

export const AI_PROVIDERS_STORAGE_KEY = "studyapp_ai_providers_v1";
export const ACTIVE_AI_PROVIDER_STORAGE_KEY = "studyapp_active_ai_provider";

export const DEFAULT_AI_PROVIDERS: AiProviderConfig[] = [
  { id: "gemini", label: "Gemini", url: "https://gemini.google.com/app", pinned: true, isCustom: false },
  { id: "chatgpt", label: "ChatGPT", url: "https://chatgpt.com/", pinned: true, isCustom: false },
  { id: "claude", label: "Claude", url: "https://claude.ai/new", pinned: true, isCustom: false },
  { id: "notebooklm", label: "NotebookLM", url: "https://notebooklm.google.com/", pinned: true, isCustom: false },
];

export const KNOWN_AI_CATALOG: Array<{
  keywords: string[];
  id: string;
  label: string;
  url: string;
  description: string;
}> = [
  {
    keywords: ["perplexity", "pplx", "perplexity ai"],
    id: "perplexity",
    label: "Perplexity",
    url: "https://www.perplexity.ai/",
    description: "Real-time clinical literature & citation search engine",
  },
  {
    keywords: ["deepseek", "deepseek r1", "deepseek v3"],
    id: "deepseek",
    label: "DeepSeek",
    url: "https://chat.deepseek.com/",
    description: "DeepSeek R1/V3 reasoning chat interface",
  },
  {
    keywords: ["grok", "xai", "grok 3"],
    id: "grok",
    label: "Grok",
    url: "https://grok.com/",
    description: "xAI Grok conversational reasoning assistant",
  },
  {
    keywords: ["copilot", "microsoft copilot", "bing chat"],
    id: "copilot",
    label: "MS Copilot",
    url: "https://copilot.microsoft.com/",
    description: "Microsoft Copilot web assistant",
  },
  {
    keywords: ["poe", "quora poe"],
    id: "poe",
    label: "Poe",
    url: "https://poe.com/",
    description: "Multi-model aggregator (Claude, GPT, Llama, Qwen)",
  },
  {
    keywords: ["mistral", "le chat", "lechat"],
    id: "mistral",
    label: "Mistral Le Chat",
    url: "https://chat.mistral.ai/",
    description: "Mistral AI fast frontier assistant",
  },
  {
    keywords: ["huggingface", "huggingchat", "hf chat"],
    id: "huggingchat",
    label: "HuggingChat",
    url: "https://huggingface.co/chat/",
    description: "Open-weights medical & scientific LLM chat",
  },
  {
    keywords: ["qwen", "qwen chat", "tongyi"],
    id: "qwen_chat",
    label: "Qwen Chat",
    url: "https://chat.qwen.ai/",
    description: "Alibaba Qwen 2.5 Max / QwQ web assistant",
  },
  {
    keywords: ["openevidence", "open evidence", "medical ai"],
    id: "openevidence",
    label: "OpenEvidence",
    url: "https://www.openevidence.com/",
    description: "Peer-reviewed clinical decision support AI",
  },
  {
    keywords: ["consensus", "consensus app"],
    id: "consensus",
    label: "Consensus",
    url: "https://consensus.app/search/",
    description: "Academic & PubMed research synthesis engine",
  },
];

export function sanitizeProviderId(rawName: string): string {
  const slug = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || `custom_ai_${Date.now()}`;
}

export function resolveChatbotSearchCandidates(query: string): Array<{
  id: string;
  label: string;
  url: string;
  description: string;
}> {
  const trimmed = query.trim();
  if (!trimmed) {
    return KNOWN_AI_CATALOG.map(({ id, label, url, description }) => ({
      id,
      label,
      url,
      description,
    }));
  }

  const lower = trimmed.toLowerCase();
  const matches = KNOWN_AI_CATALOG.filter(
    (item) =>
      item.label.toLowerCase().includes(lower) ||
      item.id.includes(lower) ||
      item.keywords.some((k) => k.includes(lower) || lower.includes(k))
  ).map(({ id, label, url, description }) => ({ id, label, url, description }));

  if (trimmed.includes(".") && !trimmed.includes(" ")) {
    const normalizedUrl =
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`;
    try {
      const host = new URL(normalizedUrl).hostname.replace(/^www\./, "");
      const brand = host.split(".")[0];
      const label = brand.charAt(0).toUpperCase() + brand.slice(1);
      const id = sanitizeProviderId(brand);
      if (!matches.some((m) => m.url === normalizedUrl)) {
        matches.unshift({
          id,
          label,
          url: normalizedUrl,
          description: `Direct web session (${normalizedUrl})`,
        });
      }
    } catch {
      // Fall through to search URL
    }
  }

  const customId = sanitizeProviderId(trimmed);
  const searchUrl = `https://duckduckgo.com/?q=${encodeURIComponent(trimmed + " AI chat login")}`;
  if (!matches.some((m) => m.id === customId)) {
    matches.push({
      id: customId,
      label: trimmed,
      url: searchUrl,
      description: `Search & pin "${trimmed}" in persistent study_session browser`,
    });
  }

  return matches;
}

export function loadSavedAiProviders(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): AiProviderConfig[] {
  try {
    const raw = storage.getItem(AI_PROVIDERS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const merged: AiProviderConfig[] = [...DEFAULT_AI_PROVIDERS];
        for (const item of parsed) {
          if (item && typeof item.id === "string" && typeof item.label === "string" && typeof item.url === "string") {
            const existingIdx = merged.findIndex((m) => m.id === item.id);
            if (existingIdx >= 0) {
              merged[existingIdx] = { ...merged[existingIdx], ...item };
            } else {
              merged.push({
                id: item.id,
                label: item.label,
                url: item.url,
                pinned: item.pinned !== false,
                isCustom: true,
              });
            }
          }
        }
        return merged;
      }
    }
  } catch {
    // Ignore storage read error
  }
  return [...DEFAULT_AI_PROVIDERS];
}

export async function saveAiProviders(
  providers: AiProviderConfig[],
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage
): Promise<void> {
  try {
    storage.setItem(AI_PROVIDERS_STORAGE_KEY, JSON.stringify(providers));
  } catch {
    // Ignore storage error
  }

  try {
    const db = await Database.load(SQLITE_DB_URI);
    await db.execute(
      `CREATE TABLE IF NOT EXISTS ai_providers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        url TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 100,
        is_custom INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`
    );
    for (let i = 0; i < providers.length; i++) {
      const p = providers[i];
      await db.execute(
        `INSERT OR REPLACE INTO ai_providers (id, label, url, pinned, sort_order, is_custom)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [p.id, p.label, p.url, p.pinned ? 1 : 0, i, p.isCustom ? 1 : 0]
      );
    }
  } catch {
    // Safe fallback in browser preview
  }
}

export async function addOrPinAiProvider(
  candidate: { id?: string; label: string; url: string },
  existingList?: AiProviderConfig[],
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage
): Promise<{ providers: AiProviderConfig[]; added: AiProviderConfig }> {
  const current = existingList ? [...existingList] : loadSavedAiProviders(storage);
  const id = candidate.id ? sanitizeProviderId(candidate.id) : sanitizeProviderId(candidate.label);
  const cleanUrl =
    candidate.url.startsWith("http://") || candidate.url.startsWith("https://")
      ? candidate.url.trim()
      : `https://${candidate.url.trim()}`;

  const newEntry: AiProviderConfig = {
    id,
    label: candidate.label.trim() || id,
    url: cleanUrl,
    pinned: true,
    isCustom: !DEFAULT_AI_PROVIDERS.some((d) => d.id === id),
  };

  const idx = current.findIndex((p) => p.id === id);
  if (idx >= 0) {
    current[idx] = newEntry;
  } else {
    current.push(newEntry);
  }

  await saveAiProviders(current, storage);
  return { providers: current, added: newEntry };
}

export async function removeCustomAiProvider(
  providerId: string,
  existingList?: AiProviderConfig[],
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage
): Promise<AiProviderConfig[]> {
  const current = existingList ? [...existingList] : loadSavedAiProviders(storage);
  const filtered = current.filter(
    (p) => p.id !== providerId || DEFAULT_AI_PROVIDERS.some((d) => d.id === p.id)
  );
  await saveAiProviders(filtered, storage);
  try {
    const db = await Database.load(SQLITE_DB_URI);
    await db.execute(`DELETE FROM ai_providers WHERE id = $1 AND is_custom = 1`, [providerId]);
  } catch {
    // Safe fallback
  }
  return filtered;
}

export const MAX_INLINE_PINNED_AI_TABS = 4;

export function partitionPinnedProviders(providers: AiProviderConfig[]): {
  inlineProviders: AiProviderConfig[];
  overflowProviders: AiProviderConfig[];
} {
  const pinned = providers.filter((p) => p.pinned !== false);
  return {
    inlineProviders: pinned.slice(0, MAX_INLINE_PINNED_AI_TABS),
    overflowProviders: pinned.slice(MAX_INLINE_PINNED_AI_TABS),
  };
}
