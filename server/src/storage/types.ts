export type Permission = 'viewer' | 'editor';
export type Role = Permission | 'owner';

export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: number;
}

export interface DocumentRecord {
  id: string;
  title: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
}

export interface DocumentListItem extends DocumentRecord {
  role: Role;
}

export interface ShareRecord {
  documentId: string;
  userId: string;
  permission: Permission;
  email: string;
  name: string;
}

export interface SnapshotMeta {
  id: string;
  documentId: string;
  label: string | null;
  createdAt: number;
  sizeBytes: number;
}

/**
 * Storage abstraction. The default implementation is SQLite (zero external
 * services); a PostgreSQL implementation is selected when DATABASE_URL is set.
 * All methods are Promise-based so async drivers (pg) and sync drivers
 * (better-sqlite3 / node:sqlite) fit the same interface.
 */
export interface StorageAdapter {
  init(): Promise<void>;
  close(): Promise<void>;

  // --- users ---
  createUser(u: { id: string; email: string; name: string; passwordHash: string }): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(id: string): Promise<UserRecord | null>;

  // --- documents ---
  createDocument(d: { id: string; title: string; ownerId: string }): Promise<DocumentRecord>;
  getDocument(id: string): Promise<DocumentRecord | null>;
  listDocumentsForUser(userId: string): Promise<DocumentListItem[]>;
  renameDocument(id: string, title: string): Promise<void>;
  touchDocument(id: string): Promise<void>;
  deleteDocument(id: string): Promise<void>;

  // --- sharing / permissions ---
  upsertShare(documentId: string, userId: string, permission: Permission): Promise<void>;
  removeShare(documentId: string, userId: string): Promise<void>;
  listShares(documentId: string): Promise<ShareRecord[]>;
  /** Effective role of a user on a document ('owner' beats shares); null = no access. */
  getRole(documentId: string, userId: string): Promise<Role | null>;

  // --- Yjs document state (latest full state, overwritten by debounced saves) ---
  saveState(documentId: string, state: Uint8Array): Promise<void>;
  loadState(documentId: string): Promise<Uint8Array | null>;

  // --- snapshot history (bounded, newest first) ---
  addSnapshot(documentId: string, state: Uint8Array, label?: string | null): Promise<SnapshotMeta>;
  listSnapshots(documentId: string): Promise<SnapshotMeta[]>;
  getSnapshotState(snapshotId: string, documentId: string): Promise<Uint8Array | null>;
  getLatestSnapshotState(documentId: string): Promise<Uint8Array | null>;
}
