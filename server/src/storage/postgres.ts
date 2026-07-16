import { randomUUID } from 'node:crypto';
import pg from 'pg';
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
 * PostgreSQL adapter (selected via DATABASE_URL). Functionally identical to
 * the SQLite adapter; this is what you would run in production.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_shares (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission IN ('viewer','editor')),
  PRIMARY KEY (document_id, user_id)
);
CREATE TABLE IF NOT EXISTS document_state (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  state BYTEA NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  state BYTEA NOT NULL,
  label TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_doc ON snapshots (document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares (user_id);
`;

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  created_at: string | number;
}

interface DocumentRow {
  id: string;
  title: string;
  owner_id: string;
  created_at: string | number;
  updated_at: string | number;
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

class PostgresStorage implements StorageAdapter {
  private readonly pool: pg.Pool;

  constructor(connectionString: string, private readonly historyLimit: number) {
    this.pool = new pg.Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createUser(u: { id: string; email: string; name: string; passwordHash: string }): Promise<UserRecord> {
    const now = Date.now();
    await this.pool.query(
      'INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
      [u.id, u.email, u.name, u.passwordHash, now],
    );
    return { ...u, createdAt: now };
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const res = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    return res.rows[0] ? mapUser(res.rows[0]) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const res = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return res.rows[0] ? mapUser(res.rows[0]) : null;
  }

  async createDocument(d: { id: string; title: string; ownerId: string }): Promise<DocumentRecord> {
    const now = Date.now();
    await this.pool.query(
      'INSERT INTO documents (id, title, owner_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)',
      [d.id, d.title, d.ownerId, now, now],
    );
    return { ...d, createdAt: now, updatedAt: now };
  }

  async getDocument(id: string): Promise<DocumentRecord | null> {
    const res = await this.pool.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [id]);
    return res.rows[0] ? mapDocument(res.rows[0]) : null;
  }

  async listDocumentsForUser(userId: string): Promise<DocumentListItem[]> {
    const res = await this.pool.query<DocumentRow & { role: Role }>(
      `SELECT d.*, 'owner' AS role FROM documents d WHERE d.owner_id = $1
       UNION ALL
       SELECT d.*, s.permission AS role FROM documents d
         JOIN document_shares s ON s.document_id = d.id
         WHERE s.user_id = $1
       ORDER BY updated_at DESC`,
      [userId],
    );
    return res.rows.map((row) => ({ ...mapDocument(row), role: row.role }));
  }

  async renameDocument(id: string, title: string): Promise<void> {
    await this.pool.query('UPDATE documents SET title = $1, updated_at = $2 WHERE id = $3', [title, Date.now(), id]);
  }

  async touchDocument(id: string): Promise<void> {
    await this.pool.query('UPDATE documents SET updated_at = $1 WHERE id = $2', [Date.now(), id]);
  }

  async deleteDocument(id: string): Promise<void> {
    await this.pool.query('DELETE FROM documents WHERE id = $1', [id]); // cascades
  }

  async upsertShare(documentId: string, userId: string, permission: Permission): Promise<void> {
    await this.pool.query(
      `INSERT INTO document_shares (document_id, user_id, permission) VALUES ($1, $2, $3)
       ON CONFLICT (document_id, user_id) DO UPDATE SET permission = EXCLUDED.permission`,
      [documentId, userId, permission],
    );
  }

  async removeShare(documentId: string, userId: string): Promise<void> {
    await this.pool.query('DELETE FROM document_shares WHERE document_id = $1 AND user_id = $2', [documentId, userId]);
  }

  async listShares(documentId: string): Promise<ShareRecord[]> {
    const res = await this.pool.query<{
      document_id: string;
      user_id: string;
      permission: Permission;
      email: string;
      name: string;
    }>(
      `SELECT s.document_id, s.user_id, s.permission, u.email, u.name
       FROM document_shares s JOIN users u ON u.id = s.user_id
       WHERE s.document_id = $1 ORDER BY u.email`,
      [documentId],
    );
    return res.rows.map((r) => ({
      documentId: r.document_id,
      userId: r.user_id,
      permission: r.permission,
      email: r.email,
      name: r.name,
    }));
  }

  async getRole(documentId: string, userId: string): Promise<Role | null> {
    const doc = await this.pool.query<{ owner_id: string }>('SELECT owner_id FROM documents WHERE id = $1', [documentId]);
    if (!doc.rows[0]) return null;
    if (doc.rows[0].owner_id === userId) return 'owner';
    const share = await this.pool.query<{ permission: Permission }>(
      'SELECT permission FROM document_shares WHERE document_id = $1 AND user_id = $2',
      [documentId, userId],
    );
    return share.rows[0] ? share.rows[0].permission : null;
  }

  async saveState(documentId: string, state: Uint8Array): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO document_state (document_id, state, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (document_id) DO UPDATE SET state = EXCLUDED.state, updated_at = EXCLUDED.updated_at`,
      [documentId, Buffer.from(state), now],
    );
    await this.pool.query('UPDATE documents SET updated_at = $1 WHERE id = $2', [now, documentId]);
  }

  async loadState(documentId: string): Promise<Uint8Array | null> {
    const res = await this.pool.query<{ state: Buffer }>(
      'SELECT state FROM document_state WHERE document_id = $1',
      [documentId],
    );
    return res.rows[0] ? new Uint8Array(res.rows[0].state) : null;
  }

  async addSnapshot(documentId: string, state: Uint8Array, label: string | null = null): Promise<SnapshotMeta> {
    const id = randomUUID();
    const now = Date.now();
    await this.pool.query(
      'INSERT INTO snapshots (id, document_id, state, label, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, documentId, Buffer.from(state), label, now],
    );
    await this.pool.query(
      `DELETE FROM snapshots WHERE document_id = $1 AND id NOT IN (
         SELECT id FROM snapshots WHERE document_id = $1 ORDER BY created_at DESC LIMIT $2
       )`,
      [documentId, this.historyLimit],
    );
    return { id, documentId, label, createdAt: now, sizeBytes: state.byteLength };
  }

  async listSnapshots(documentId: string): Promise<SnapshotMeta[]> {
    const res = await this.pool.query<{
      id: string;
      document_id: string;
      label: string | null;
      created_at: string | number;
      size_bytes: string | number;
    }>(
      `SELECT id, document_id, label, created_at, length(state) AS size_bytes
       FROM snapshots WHERE document_id = $1 ORDER BY created_at DESC`,
      [documentId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      documentId: r.document_id,
      label: r.label,
      createdAt: Number(r.created_at),
      sizeBytes: Number(r.size_bytes),
    }));
  }

  async getSnapshotState(snapshotId: string, documentId: string): Promise<Uint8Array | null> {
    const res = await this.pool.query<{ state: Buffer }>(
      'SELECT state FROM snapshots WHERE id = $1 AND document_id = $2',
      [snapshotId, documentId],
    );
    return res.rows[0] ? new Uint8Array(res.rows[0].state) : null;
  }

  async getLatestSnapshotState(documentId: string): Promise<Uint8Array | null> {
    const res = await this.pool.query<{ state: Buffer }>(
      'SELECT state FROM snapshots WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1',
      [documentId],
    );
    return res.rows[0] ? new Uint8Array(res.rows[0].state) : null;
  }
}

export async function createPostgresStorage(connectionString: string, historyLimit: number): Promise<StorageAdapter> {
  const storage = new PostgresStorage(connectionString, historyLimit);
  await storage.init();
  return storage;
}
