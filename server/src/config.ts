import path from 'node:path';
import dotenv from 'dotenv';

// Load .env from the current working directory (server/) and, as a fallback,
// from the repo root (when scripts are run through the npm workspace).
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

export interface ServerConfig {
  port: number;
  jwtSecret: string;
  sqlitePath: string;
  databaseUrl: string | null;
  snapshotDebounceMs: number;
  snapshotHistoryLimit: number;
  clientOrigin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: parseInt(env.PORT ?? '4000', 10),
    jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
    sqlitePath: env.SQLITE_PATH ?? './data/collab.db',
    databaseUrl: env.DATABASE_URL || null,
    snapshotDebounceMs: parseInt(env.SNAPSHOT_DEBOUNCE_MS ?? '2000', 10),
    snapshotHistoryLimit: parseInt(env.SNAPSHOT_HISTORY_LIMIT ?? '20', 10),
    clientOrigin: env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  };
}
