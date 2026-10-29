import { appLocalDataDir, join } from "@tauri-apps/api/path";
import { mkdir, BaseDirectory } from "@tauri-apps/plugin-fs";

export const APP_DATA_SUBDIRS = [
  "vault",
  "images",
  "srs_data",
  ".webview_partitions/persist_study_session",
] as const;

export const PORTABLE_SQLITE_DB_URI = "sqlite:srs_data/studyapp_srs.db";

let cachedAppLocalDataRoot: string | null = null;

/**
 * Resolves the OS-specific `$APPLOCALDATA` root directory via Tauri v2's `@tauri-apps/api/path`.
 * Falls back gracefully to OS environment variables or `$APPLOCALDATA` when running in headless Vitest/browser preview.
 */
export async function resolveAppLocalDataRoot(): Promise<string> {
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
    // Running outside native Tauri shell (e.g., Vitest or browser preview)
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
 * Resolves a path inside `$APPLOCALDATA` using `@tauri-apps/api/path`'s `join`.
 */
export async function resolveAppDataSubPath(...segments: string[]): Promise<string> {
  const root = await resolveAppLocalDataRoot();
  try {
    return await join(root, ...segments);
  } catch {
    const cleanSegments = segments.map((s) => s.replace(/^[\\/]+|[\\/]+$/g, ""));
    return [root, ...cleanSegments].join("/");
  }
}

/**
 * Automatically creates the `vault`, `images`, `srs_data`, and `.webview_partitions/persist_study_session`
 * subdirectories inside `$APPLOCALDATA` on startup if they are missing.
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
 * Resolves the dynamic SQLite connection URI inside `$APPLOCALDATA/srs_data/studyapp_srs.db`.
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
