import type { ServerConfig } from '../config.js';
import type { StorageAdapter } from './types.js';
import { createSqliteStorage } from './sqlite.js';
import { createPostgresStorage } from './postgres.js';

export * from './types.js';
export { createSqliteStorage } from './sqlite.js';
export { createPostgresStorage } from './postgres.js';

/** Pick a storage backend: PostgreSQL when DATABASE_URL is set, SQLite otherwise. */
export async function createStorage(config: ServerConfig): Promise<StorageAdapter> {
  if (config.databaseUrl) {
    return createPostgresStorage(config.databaseUrl, config.snapshotHistoryLimit);
  }
  return createSqliteStorage(config.sqlitePath, config.snapshotHistoryLimit);
}
