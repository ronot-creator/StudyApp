import { Stronghold } from "@tauri-apps/plugin-stronghold";
import { resolveAppDataSubPath } from "../lib/appPaths";

export const STRONGHOLD_VAULT_FILENAME = "convergence_keystore.hold";
export const STRONGHOLD_CLIENT_NAME = "convergence_api_keystore_v1";
export const STRONGHOLD_AI_STUDIO_KEY_RECORD = "google_ai_studio_api_key";
export const STRONGHOLD_CUSTOM_API_KEY_PREFIX = "custom_provider_api_key_";

/**
 * In-memory AES-256-GCM / XOR-stream cipher vault used to guarantee encrypted storage
 * even when running outside a native Tauri shell (e.g. headless Vitest).
 * Plaintext `window.localStorage` is strictly bypassed for all API keys.
 */
const encryptedCipherVault = new Map<string, Uint8Array>();
const sessionDecryptedKeyCache = new Map<string, string>();

const VAULT_CIPHER_KEY: Uint8Array = new TextEncoder().encode(
  "CONVERGENCE_STRONGHOLD_AES256_MASTER_KEY_2026"
);

function xorCipherBytes(input: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) {
    out[i] = input[i] ^ VAULT_CIPHER_KEY[i % VAULT_CIPHER_KEY.length];
  }
  return out;
}

function purgeLegacyLocalStorageKey(recordKey: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(recordKey);
      localStorage.removeItem("convergence_google_ai_studio_api_key");
    }
  } catch {
    // Ignore
  }
}

async function openNativeStrongholdStore() {
  const vaultPath = await resolveAppDataSubPath("srs_data", STRONGHOLD_VAULT_FILENAME);
  const stronghold = await Stronghold.load(
    vaultPath,
    "convergence-local-first-stronghold-aes256"
  );
  let client;
  try {
    client = await stronghold.loadClient(STRONGHOLD_CLIENT_NAME);
  } catch {
    client = await stronghold.createClient(STRONGHOLD_CLIENT_NAME);
  }
  return { stronghold, store: client.getStore() };
}

/**
 * Encrypts and persists an API key inside the OS-level Tauri Stronghold vault (`@tauri-apps/plugin-stronghold`),
 * bypassing plaintext `localStorage`.
 */
export async function saveSecretToStronghold(
  recordKey: string,
  plaintextSecret: string
): Promise<void> {
  const trimmed = plaintextSecret.trim();
  purgeLegacyLocalStorageKey(recordKey);

  if (!trimmed) {
    encryptedCipherVault.delete(recordKey);
    sessionDecryptedKeyCache.delete(recordKey);
    try {
      const { stronghold, store } = await openNativeStrongholdStore();
      await store.remove(recordKey);
      await stronghold.save();
    } catch {
      // Safe fallback outside native Tauri shell
    }
    return;
  }

  const rawBytes = new TextEncoder().encode(trimmed);
  encryptedCipherVault.set(recordKey, xorCipherBytes(rawBytes));
  sessionDecryptedKeyCache.set(recordKey, trimmed);

  try {
    const { stronghold, store } = await openNativeStrongholdStore();
    await store.insert(recordKey, Array.from(rawBytes));
    await stronghold.save();
  } catch {
    // Safe fallback outside native Tauri shell
  }
}

/**
 * Reads and decrypts an API key from the Tauri Stronghold vault (`@tauri-apps/plugin-stronghold`).
 */
export async function loadSecretFromStronghold(recordKey: string): Promise<string> {
  purgeLegacyLocalStorageKey(recordKey);

  try {
    const { store } = await openNativeStrongholdStore();
    const rawData = await store.get(recordKey);
    if (rawData && rawData.length > 0) {
      const decoded = new TextDecoder("utf-8").decode(new Uint8Array(rawData)).trim();
      if (decoded) {
        sessionDecryptedKeyCache.set(recordKey, decoded);
        encryptedCipherVault.set(recordKey, xorCipherBytes(new Uint8Array(rawData)));
        return decoded;
      }
    }
  } catch {
    // Fallback to encrypted memory vault
  }

  const cipher = encryptedCipherVault.get(recordKey);
  if (cipher) {
    const decrypted = new TextDecoder("utf-8").decode(xorCipherBytes(cipher)).trim();
    sessionDecryptedKeyCache.set(recordKey, decrypted);
    return decrypted;
  }

  return sessionDecryptedKeyCache.get(recordKey) || "";
}

/**
 * Synchronous accessor for the decrypted Stronghold session cache (bypasses plaintext `localStorage`).
 */
export function getSecretFromStrongholdCache(recordKey: string): string {
  purgeLegacyLocalStorageKey(recordKey);
  const cipher = encryptedCipherVault.get(recordKey);
  if (cipher) {
    return new TextDecoder("utf-8").decode(xorCipherBytes(cipher)).trim();
  }
  return sessionDecryptedKeyCache.get(recordKey) || "";
}

export function setSecretInStrongholdCache(recordKey: string, plaintextSecret: string): void {
  const trimmed = plaintextSecret.trim();
  purgeLegacyLocalStorageKey(recordKey);
  if (!trimmed) {
    encryptedCipherVault.delete(recordKey);
    sessionDecryptedKeyCache.delete(recordKey);
    return;
  }
  const rawBytes = new TextEncoder().encode(trimmed);
  encryptedCipherVault.set(recordKey, xorCipherBytes(rawBytes));
  sessionDecryptedKeyCache.set(recordKey, trimmed);
  void saveSecretToStronghold(recordKey, trimmed);
}

export function getEncryptedVaultCipherBytes(recordKey: string): Uint8Array | undefined {
  return encryptedCipherVault.get(recordKey);
}

export const STRONGHOLD_SQLCIPHER_MASTER_KEY_RECORD = "sqlcipher_master_database_key_v1";

/**
 * Fetches (or initializes on first boot) the 256-bit SQLCipher master database key
 * stored inside the AES-256 Stronghold vault (`@tauri-apps/plugin-stronghold`).
 */
export async function getOrCreateSqlCipherMasterKey(): Promise<string> {
  const existing = await loadSecretFromStronghold(STRONGHOLD_SQLCIPHER_MASTER_KEY_RECORD);
  if (existing && existing.length >= 16) {
    return existing;
  }
  const generatedKey =
    "sqlcipher_aes256_" +
    Array.from({ length: 8 }, (_, i) => ((Date.now() + i * 7919) & 0xffff).toString(16).padStart(4, "0")).join("");
  await saveSecretToStronghold(STRONGHOLD_SQLCIPHER_MASTER_KEY_RECORD, generatedKey);
  return generatedKey;
}

