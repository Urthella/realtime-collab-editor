import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DocumentListItem,
  DocumentRecord,
  Permission,
  Role,
  ShareRecord,
  SnapshotMeta,
  StorageAdapter,
  UserRecord,
} from './types.js';

/**
 * Minimal common surface of `better-sqlite3` and the built-in `node:sqlite`
 * (both are synchronous and share prepare/run/get/all semantics).
 */
interface SqlStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

async function openDatabase(dbPath: string): Promise<{ db: SqlDatabase; driver: string }> {
  try {
    const mod = await import('better-sqlite3');
    const BetterSqlite3 = mod.default as unknown as new (p: string) => SqlDatabase;
    return { db: new BetterSqlite3(dbPath), driver: 'better-sqlite3' };
  } catch {
    // Fallback for environments where the native module could not be built:
    // Node's built-in SQLite (available on Node >= 22.5).
    const sqlite = await import('node:sqlite');
    const DatabaseSync = sqlite.DatabaseSync as unknown as new (p: string) => SqlDatabase;
    return { db: new DatabaseSync(dbPath), driver: 'node:sqlite' };
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS document_shares (
  document_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('viewer','editor')),
  PRIMARY KEY (document_id, user_id)
);
CREATE TABLE IF NOT EXISTS document_state (
  document_id TEXT PRIMARY KEY,
  state BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  state BLOB NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_doc ON snapshots (document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares (user_id);
`;

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: number;
}

interface DocumentRow {
  id: string;
  title: string;
  owner_id: string;
  created_at: number;
  updated_at: number;
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    createdAt: Number(row.created_at),
  };
}

function mapDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Normalize a BLOB column (Buffer from better-sqlite3, Uint8Array from node:sqlite). */
function toBytes(value: unknown): Uint8Array {
  const u8 = value as Uint8Array;
  return new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength).slice();
}

class SqliteStorage implements StorageAdapter {
  constructor(
    private readonly db: SqlDatabase,
    readonly driver: string,
    private readonly historyLimit: number,
  ) {}

  async init(): Promise<void> {
    this.db.exec(SCHEMA);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // --- users ---

  async createUser(u: { id: string; email: string; name: string; passwordHash: string }): Promise<UserRecord> {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(u.id, u.email, u.name, u.passwordHash, now);
    return { ...u, createdAt: now };
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? mapUser(row) : null;
  }

  // --- documents ---

  async createDocument(d: { id: string; title: string; ownerId: string }): Promise<DocumentRecord> {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO documents (id, title, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(d.id, d.title, d.ownerId, now, now);
    return { ...d, createdAt: now, updatedAt: now };
  }

  async getDocument(id: string): Promise<DocumentRecord | null> {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
    return row ? mapDocument(row) : null;
  }

  async listDocumentsForUser(userId: string): Promise<DocumentListItem[]> {
    const rows = this.db
      .prepare(
        `SELECT d.*, 'owner' AS role FROM documents d WHERE d.owner_id = ?
         UNION ALL
         SELECT d.*, s.permission AS role FROM documents d
           JOIN document_shares s ON s.document_id = d.id
           WHERE s.user_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(userId, userId) as Array<DocumentRow & { role: Role }>;
    return rows.map((row) => ({ ...mapDocument(row), role: row.role }));
  }

  async renameDocument(id: string, title: string): Promise<void> {
    this.db.prepare('UPDATE documents SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id);
  }

  async touchDocument(id: string): Promise<void> {
    this.db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  async deleteDocument(id: string): Promise<void> {
    this.db.prepare('DELETE FROM document_shares WHERE document_id = ?').run(id);
    this.db.prepare('DELETE FROM document_state WHERE document_id = ?').run(id);
    this.db.prepare('DELETE FROM snapshots WHERE document_id = ?').run(id);
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  }

  // --- sharing ---

  async upsertShare(documentId: string, userId: string, permission: Permission): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO document_shares (document_id, user_id, permission) VALUES (?, ?, ?)
         ON CONFLICT (document_id, user_id) DO UPDATE SET permission = excluded.permission`,
      )
      .run(documentId, userId, permission);
  }

  async removeShare(documentId: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?').run(documentId, userId);
  }

  async listShares(documentId: string): Promise<ShareRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT s.document_id, s.user_id, s.permission, u.email, u.name
         FROM document_shares s JOIN users u ON u.id = s.user_id
         WHERE s.document_id = ? ORDER BY u.email`,
      )
      .all(documentId) as Array<{ document_id: string; user_id: string; permission: Permission; email: string; name: string }>;
    return rows.map((r) => ({
      documentId: r.document_id,
      userId: r.user_id,
      permission: r.permission,
      email: r.email,
      name: r.name,
    }));
  }

  async getRole(documentId: string, userId: string): Promise<Role | null> {
    const doc = this.db.prepare('SELECT owner_id FROM documents WHERE id = ?').get(documentId) as
      | { owner_id: string }
      | undefined;
    if (!doc) return null;
    if (doc.owner_id === userId) return 'owner';
    const share = this.db
      .prepare('SELECT permission FROM document_shares WHERE document_id = ? AND user_id = ?')
      .get(documentId, userId) as { permission: Permission } | undefined;
    return share ? share.permission : null;
  }

  // --- Yjs state ---

  async saveState(documentId: string, state: Uint8Array): Promise<void> {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO document_state (document_id, state, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (document_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      )
      .run(documentId, Buffer.from(state), now);
    this.db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(now, documentId);
  }

  async loadState(documentId: string): Promise<Uint8Array | null> {
    const row = this.db.prepare('SELECT state FROM document_state WHERE document_id = ?').get(documentId) as
      | { state: unknown }
      | undefined;
    return row ? toBytes(row.state) : null;
  }

  // --- snapshots ---

  async addSnapshot(documentId: string, state: Uint8Array, label: string | null = null): Promise<SnapshotMeta> {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare('INSERT INTO snapshots (id, document_id, state, label, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, documentId, Buffer.from(state), label, now);
    // Prune to the newest `historyLimit` snapshots for this document.
    this.db
      .prepare(
        `DELETE FROM snapshots WHERE document_id = ? AND id NOT IN (
           SELECT id FROM snapshots WHERE document_id = ?
           ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`,
      )
      .run(documentId, documentId, this.historyLimit);
    return { id, documentId, label, createdAt: now, sizeBytes: state.byteLength };
  }

  async listSnapshots(documentId: string): Promise<SnapshotMeta[]> {
    const rows = this.db
      .prepare(
        `SELECT id, document_id, label, created_at, length(state) AS size_bytes
         FROM snapshots WHERE document_id = ? ORDER BY created_at DESC, rowid DESC`,
      )
      .all(documentId) as Array<{ id: string; document_id: string; label: string | null; created_at: number; size_bytes: number }>;
    return rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      label: r.label,
      createdAt: Number(r.created_at),
      sizeBytes: Number(r.size_bytes),
    }));
  }

  async getSnapshotState(snapshotId: string, documentId: string): Promise<Uint8Array | null> {
    const row = this.db
      .prepare('SELECT state FROM snapshots WHERE id = ? AND document_id = ?')
      .get(snapshotId, documentId) as { state: unknown } | undefined;
    return row ? toBytes(row.state) : null;
  }

  async getLatestSnapshotState(documentId: string): Promise<Uint8Array | null> {
    const row = this.db
      .prepare('SELECT state FROM snapshots WHERE document_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get(documentId) as { state: unknown } | undefined;
    return row ? toBytes(row.state) : null;
  }
}

export async function createSqliteStorage(dbPath: string, historyLimit: number): Promise<StorageAdapter> {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const { db, driver } = await openDatabase(dbPath);
  const storage = new SqliteStorage(db, driver, historyLimit);
  await storage.init();
  return storage;
}
