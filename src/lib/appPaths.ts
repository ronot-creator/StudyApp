import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { BaseDirectory, exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

export const STORAGE_CONFIG_FILENAME = "storage_config.json";
export const STORAGE_CONFIG_MAX_BYTES = 1024;
export const STORAGE_CONFIG_LOCALSTORAGE_KEY = "convergence_storage_config_v1";

export const APP_DATA_SUBDIRS = [
  "vault",
  "images",
  "srs_data",
  "tesseract_langs",
  ".webview_partitions/persist_study_session",
] as const;

export const PORTABLE_SQLITE_DB_URI = "sqlite:srs_data/studyapp_srs.db";

export interface StorageBootstrapConfig {
  version: string;
  customTargetDir: string;
  firstRunCompleted: boolean;
  updatedAt: string;
}

let cachedAppLocalDataRoot: string | null = null;

export function clearCachedAppLocalDataRoot(): void {
  cachedAppLocalDataRoot = null;
}

/**
 * Reads the 1KB bootstrap config file (`storage_config.json`) from standard OS AppData
 * (or localStorage in browser/Vitest environments) to determine the user's custom target drive
 * (e.g., `D:\Convergence`).
 */
export async function readStorageBootstrapConfig(
  storage?: Pick<Storage, "getItem">
): Promise<StorageBootstrapConfig | null> {
  const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  try {
    const rawLocal = s?.getItem(STORAGE_CONFIG_LOCALSTORAGE_KEY);
    if (rawLocal && rawLocal.length <= STORAGE_CONFIG_MAX_BYTES) {
      const parsed = JSON.parse(rawLocal) as Partial<StorageBootstrapConfig>;
      if (typeof parsed.customTargetDir === "string" && parsed.customTargetDir.trim()) {
        return {
          version: parsed.version || "1.0",
          customTargetDir: parsed.customTargetDir.trim().replace(/[\\/]+$/, ""),
          firstRunCompleted: Boolean(parsed.firstRunCompleted ?? true),
          updatedAt: parsed.updatedAt || new Date().toISOString(),
        };
      }
    }
  } catch {
    // Ignore storage parse error
  }

  try {
    const ipcCfg = await invoke<{ custom_target_dir?: string; first_run_completed?: boolean }>(
      "get_storage_config"
    );
    if (ipcCfg && typeof ipcCfg.custom_target_dir === "string" && ipcCfg.custom_target_dir.trim()) {
      return {
        version: "1.0",
        customTargetDir: ipcCfg.custom_target_dir.trim().replace(/[\\/]+$/, ""),
        firstRunCompleted: Boolean(ipcCfg.first_run_completed ?? true),
        updatedAt: new Date().toISOString(),
      };
    }
  } catch {
    // Fallback to Tauri fs plugin
  }

  try {
    const hasCfg = await exists(STORAGE_CONFIG_FILENAME, { baseDir: BaseDirectory.AppLocalData });
    if (hasCfg) {
      const raw = await readTextFile(STORAGE_CONFIG_FILENAME, {
        baseDir: BaseDirectory.AppLocalData,
      });
      if (raw && raw.length <= STORAGE_CONFIG_MAX_BYTES) {
        const parsed = JSON.parse(raw) as Partial<StorageBootstrapConfig>;
        if (typeof parsed.customTargetDir === "string" && parsed.customTargetDir.trim()) {
          return {
            version: parsed.version || "1.0",
            customTargetDir: parsed.customTargetDir.trim().replace(/[\\/]+$/, ""),
            firstRunCompleted: Boolean(parsed.firstRunCompleted ?? true),
            updatedAt: parsed.updatedAt || new Date().toISOString(),
          };
        }
      }
    }
  } catch {
    // Running outside native Tauri shell
  }

  return null;
}

/**
 * Writes a <= 1KB `storage_config.json` file to standard OS AppData and updates all subsequent
 * Vault, Image, SRS, Tesseract, and WebView Partition path resolutions to target `customTargetDir`
 * (e.g., `D:\Convergence`).
 */
export async function setCustomStorageTargetDir(
  customTargetDir: string,
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">
): Promise<StorageBootstrapConfig> {
  const cleanTarget = customTargetDir.trim().replace(/[\\/]+$/, "");
  const payload: StorageBootstrapConfig = {
    version: "1.0",
    customTargetDir: cleanTarget,
    firstRunCompleted: true,
    updatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(payload, null, 2);
  if (serialized.length > STORAGE_CONFIG_MAX_BYTES) {
    throw new Error(`Storage bootstrap config exceeds 1KB limit (${serialized.length} bytes)`);
  }

  const s = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  try {
    if (cleanTarget) {
      s?.setItem(STORAGE_CONFIG_LOCALSTORAGE_KEY, serialized);
    } else {
      s?.removeItem(STORAGE_CONFIG_LOCALSTORAGE_KEY);
    }
  } catch {
    // Ignore
  }

  cachedAppLocalDataRoot = cleanTarget || null;

  try {
    await invoke("set_custom_storage_dir", { targetDir: cleanTarget });
  } catch {
    // Fallback to direct plugin-fs write in standard AppLocalData
    try {
      await writeTextFile(STORAGE_CONFIG_FILENAME, serialized, {
        baseDir: BaseDirectory.AppLocalData,
      });
    } catch {
      // Safe fallback in Vitest / browser preview
    }
  }

  await ensureAppDataDirectories();
  return payload;
}

/**
 * Resolves the active Convergence root directory.
 * First checks the 1KB `storage_config.json` for a custom drive override (e.g., `D:\Convergence`),
 * then falls back to OS `$APPLOCALDATA`.
 */
export async function resolveAppLocalDataRoot(
  storage?: Pick<Storage, "getItem">
): Promise<string> {
  const bootstrap = await readStorageBootstrapConfig(storage);
  if (bootstrap?.customTargetDir) {
    cachedAppLocalDataRoot = bootstrap.customTargetDir;
    return cachedAppLocalDataRoot;
  }

  if (cachedAppLocalDataRoot) {
    return cachedAppLocalDataRoot;
  }

  try {
    const dir = await appLocalDataDir();
    if (dir && dir.trim()) {
      cachedAppLocalDataRoot = dir.replace(/[\\/]+$/, "");
      return cachedAppLocalDataRoot;
    }
  } catch {
    // Running outside native Tauri shell
  }

  const g = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  };
  const env = g.process?.env ?? {};
  const fallback =
    env.CONVERGENCE_APPDATA_DIR ||
    env.STUDYAPP_APPDATA_DIR ||
    (env.LOCALAPPDATA ? `${env.LOCALAPPDATA}/com.convergence.studyapp` : "") ||
    (env.APPDATA ? `${env.APPDATA}/com.convergence.studyapp` : "") ||
    "$APPLOCALDATA";

  cachedAppLocalDataRoot = fallback.replace(/[\\/]+$/, "");
  return cachedAppLocalDataRoot;
}

/**
 * Resolves a path inside the active storage root (e.g., `D:\Convergence/vault/Renal.md` or `$APPLOCALDATA/vault/Renal.md`).
 */
export async function resolveAppDataSubPath(...segments: string[]): Promise<string> {
  const root = await resolveAppLocalDataRoot();
  const cleanSegments = segments.map((s) => s.replace(/^[\\/]+|[\\/]+$/g, ""));
  // Preserve Windows drive separator style if root looks like `D:\Convergence`
  if (/^[A-Za-z]:\\/.test(root)) {
    return [root.replace(/[\\/]+$/, ""), ...cleanSegments.map((s) => s.replace(/\//g, "\\"))].join("\\");
  }
  try {
    return await join(root, ...cleanSegments);
  } catch {
    return [root, ...cleanSegments].join("/");
  }
}

/**
 * Automatically creates `vault`, `images`, `srs_data`, `tesseract_langs`, and `.webview_partitions/persist_study_session`
 * inside the resolved target directory on startup if they are missing.
 */
export async function ensureAppDataDirectories(): Promise<string> {
  const root = await resolveAppLocalDataRoot();
  for (const sub of APP_DATA_SUBDIRS) {
    try {
      await mkdir(sub, { baseDir: BaseDirectory.AppLocalData, recursive: true });
    } catch {
      try {
        const absSub = await resolveAppDataSubPath(sub);
        await mkdir(absSub, { recursive: true });
      } catch {
        // Safe fallback in browser preview / Vitest
      }
    }
  }
  return root;
}

/**
 * Resolves the dynamic SQLite connection URI inside the active target directory's `srs_data/studyapp_srs.db`.
 */
export async function getDynamicSqliteDbUri(): Promise<string> {
  try {
    const dbFile = await resolveAppDataSubPath("srs_data", "studyapp_srs.db");
    if (dbFile && !dbFile.startsWith("$APPLOCALDATA")) {
      return `sqlite:${dbFile.replace(/\\/g, "/")}`;
    }
  } catch {
    // Fallback
  }
  return PORTABLE_SQLITE_DB_URI;
}
