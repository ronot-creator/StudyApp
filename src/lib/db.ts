import Database from "@tauri-apps/plugin-sql";
import { getDynamicSqliteDbUri } from "./appPaths";

export const SRS_SYNC_QUEUE_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS srs_sync_queue (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_srs_sync_queue_created_at ON srs_sync_queue(created_at);
`;

export const SRS_SYNC_QUEUE_LIMIT = 5000;
export const SRS_SYNC_QUEUE_HARD_LIMIT = 20000;
export const SRS_SYNC_QUEUE_DROP_OLDEST_COUNT = 2500;

export interface SrsSyncQueueRow {
  id: string;
  payload: string;
  created_at: string;
}

export interface SqliteAdapter {
  execute(sql: string, bindValues?: unknown[]): Promise<unknown>;
  select<T = unknown>(sql: string, bindValues?: unknown[]): Promise<T>;
}

const memoryQueueStore: SrsSyncQueueRow[] = [];

function createMemorySqliteAdapter(): SqliteAdapter {
  return {
    async execute(sql: string, bindValues: unknown[] = []) {
      const normalized = sql.trim().replace(/\s+/g, " ");
      if (/^INSERT INTO srs_sync_queue/i.test(normalized)) {
        const id = String(
          bindValues[0] ?? `sync_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
        );
        const payload = String(bindValues[1] ?? "{}");
        const createdAt = String(bindValues[2] ?? new Date().toISOString());
        memoryQueueStore.push({ id, payload, created_at: createdAt });
        return { rowsAffected: 1 };
      }
      if (/^DELETE FROM srs_sync_queue WHERE id IN/i.test(normalized)) {
        const dropLimit = Number(bindValues[0] ?? SRS_SYNC_QUEUE_DROP_OLDEST_COUNT);
        memoryQueueStore.sort((a, b) =>
          a.created_at === b.created_at
            ? a.id.localeCompare(b.id)
            : a.created_at.localeCompare(b.created_at)
        );
        const removed = memoryQueueStore.splice(0, Math.max(0, dropLimit));
        return { rowsAffected: removed.length };
      }
      if (/^DELETE FROM srs_sync_queue$/i.test(normalized)) {
        const len = memoryQueueStore.length;
        memoryQueueStore.length = 0;
        return { rowsAffected: len };
      }
      return { rowsAffected: 0 };
    },
    async select<T = unknown>(sql: string): Promise<T> {
      const normalized = sql.trim().replace(/\s+/g, " ");
      if (/SELECT COUNT\(\*\) as count FROM srs_sync_queue/i.test(normalized)) {
        return [{ count: memoryQueueStore.length }] as unknown as T;
      }
      if (/FROM srs_sync_queue/i.test(normalized)) {
        const sorted = [...memoryQueueStore].sort((a, b) =>
          a.created_at === b.created_at
            ? a.id.localeCompare(b.id)
            : a.created_at.localeCompare(b.created_at)
        );
        return sorted as unknown as T;
      }
      return [] as unknown as T;
    },
  };
}

let customDbAdapter: SqliteAdapter | null = null;

export function setCustomSqliteAdapter(adapter: SqliteAdapter | null): void {
  customDbAdapter = adapter;
}

export async function getSqliteConnection(): Promise<SqliteAdapter> {
  if (customDbAdapter) {
    return customDbAdapter;
  }
  const isTauri =
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  if (isTauri) {
    try {
      const uri = await getDynamicSqliteDbUri();
      const db = await Database.load(uri);
      await db.execute(SRS_SYNC_QUEUE_TABLE_DDL);
      return db as unknown as SqliteAdapter;
    } catch {
      // Fallback to in-memory store
    }
  }
  return createMemorySqliteAdapter();
}

export async function ensureSrsSyncQueueSchema(adapter?: SqliteAdapter): Promise<void> {
  const conn = adapter ?? (await getSqliteConnection());
  await conn.execute(SRS_SYNC_QUEUE_TABLE_DDL);
}

export async function getSrsSyncQueueCount(adapter?: SqliteAdapter): Promise<number> {
  const conn = adapter ?? (await getSqliteConnection());
  const rows = await conn.select<Array<{ count: number }>>(
    "SELECT COUNT(*) as count FROM srs_sync_queue"
  );
  return Number(rows?.[0]?.count ?? 0);
}

export async function getSrsSyncQueueRows(adapter?: SqliteAdapter): Promise<SrsSyncQueueRow[]> {
  const conn = adapter ?? (await getSqliteConnection());
  return await conn.select<SrsSyncQueueRow[]>(
    "SELECT id, payload, created_at FROM srs_sync_queue ORDER BY created_at ASC, id ASC"
  );
}

export async function clearSrsSyncQueue(adapter?: SqliteAdapter): Promise<void> {
  const conn = adapter ?? (await getSqliteConnection());
  await conn.execute("DELETE FROM srs_sync_queue");
}

/**
 * Enforces the `srs_sync_queue` row limit:
 * Counts rows after insertion. If `count > maxRows` (supports both the 5,000-row limit
 * dropping the oldest 50% = 2,500 rows and the 20,000-row cap deleting the 2,500 oldest rows),
 * deletes the `dropCount` (2,500) oldest rows ordered by `created_at ASC`.
 */
export async function enforceSrsSyncQueueSizeLimit(options: {
  adapter?: SqliteAdapter;
  maxRows?: number;
  dropCount?: number;
} = {}): Promise<{ beforeCount: number; afterCount: number; evictedCount: number }> {
  const conn = options.adapter ?? (await getSqliteConnection());
  const maxRows = options.maxRows ?? SRS_SYNC_QUEUE_LIMIT;
  const dropCount = options.dropCount ?? SRS_SYNC_QUEUE_DROP_OLDEST_COUNT;

  const beforeCount = await getSrsSyncQueueCount(conn);
  if (beforeCount > maxRows || beforeCount > SRS_SYNC_QUEUE_HARD_LIMIT) {
    await conn.execute(
      `DELETE FROM srs_sync_queue WHERE id IN (
        SELECT id FROM srs_sync_queue ORDER BY created_at ASC, id ASC LIMIT ?
      )`,
      [dropCount]
    );
    const afterCount = await getSrsSyncQueueCount(conn);
    return {
      beforeCount,
      afterCount,
      evictedCount: Math.max(0, beforeCount - afterCount),
    };
  }
  return {
    beforeCount,
    afterCount: beforeCount,
    evictedCount: 0,
  };
}

export async function enqueueCardsIntoSrsSyncQueue(
  cards: unknown[],
  options: {
    adapter?: SqliteAdapter;
    maxRows?: number;
    dropCount?: number;
    baseTimestampMs?: number;
  } = {}
): Promise<{ insertedCount: number; totalQueued: number; evictedCount: number }> {
  const conn = options.adapter ?? (await getSqliteConnection());
  await ensureSrsSyncQueueSchema(conn);

  const baseMs = options.baseTimestampMs ?? Date.now();
  let insertedCount = 0;

  for (let i = 0; i < cards.length; i++) {
    const item = cards[i] as Record<string, unknown>;
    const rowId =
      typeof item?.id === "string" && item.id.trim()
        ? item.id.trim()
        : `anki_queue_${baseMs}_${i}_${Math.random().toString(36).slice(2, 7)}`;
    const createdAt =
      typeof item?.created_at === "string"
        ? item.created_at
        : new Date(baseMs + i).toISOString();
    const payload = typeof item === "string" ? item : JSON.stringify(item);

    await conn.execute(
      "INSERT INTO srs_sync_queue (id, payload, created_at) VALUES (?, ?, ?)",
      [rowId, payload, createdAt]
    );
    insertedCount++;
  }

  const enforcement = await enforceSrsSyncQueueSizeLimit({
    adapter: conn,
    maxRows: options.maxRows,
    dropCount: options.dropCount,
  });

  return {
    insertedCount,
    totalQueued: enforcement.afterCount,
    evictedCount: enforcement.evictedCount,
  };
}
