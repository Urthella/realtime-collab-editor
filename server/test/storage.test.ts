import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createSqliteStorage } from '../src/storage/sqlite.js';
import type { StorageAdapter } from '../src/storage/types.js';

const HISTORY_LIMIT = 5;

describe('SQLite storage adapter', () => {
  let storage: StorageAdapter;

  beforeEach(async () => {
    storage = await createSqliteStorage(':memory:', HISTORY_LIMIT);
    const user = await storage.createUser({ id: 'u1', email: 'a@b.c', name: 'A', passwordHash: 'x' });
    await storage.createDocument({ id: 'doc1', title: 'Doc', ownerId: user.id });
  });

  it('round-trips a Yjs update: save -> load -> identical document state', async () => {
    const original = new Y.Doc();
    const fragmentText = original.getText('body');
    fragmentText.insert(0, 'Hello');
    fragmentText.insert(5, ', collaborative world!');
    original.getMap('meta').set('lang', 'en');

    await storage.saveState('doc1', Y.encodeStateAsUpdate(original));
    const loaded = await storage.loadState('doc1');
    expect(loaded).not.toBeNull();

    const replica = new Y.Doc();
    Y.applyUpdate(replica, loaded!);

    expect(replica.getText('body').toString()).toBe('Hello, collaborative world!');
    expect(replica.getMap('meta').get('lang')).toBe('en');
    // State vectors must match byte-for-byte: replica knows exactly what the original knows.
    expect(Buffer.from(Y.encodeStateVector(replica)).equals(Buffer.from(Y.encodeStateVector(original)))).toBe(true);
  });

  it('overwrites the latest state on subsequent saves (upsert, not append)', async () => {
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'v1');
    await storage.saveState('doc1', Y.encodeStateAsUpdate(doc));
    doc.getText('t').insert(2, ' v2');
    await storage.saveState('doc1', Y.encodeStateAsUpdate(doc));

    const replica = new Y.Doc();
    Y.applyUpdate(replica, (await storage.loadState('doc1'))!);
    expect(replica.getText('t').toString()).toBe('v1 v2');
  });

  it('keeps only the newest N snapshots, newest first', async () => {
    for (let i = 1; i <= HISTORY_LIMIT + 3; i++) {
      const doc = new Y.Doc();
      doc.getText('t').insert(0, `version ${i}`);
      await storage.addSnapshot('doc1', Y.encodeStateAsUpdate(doc), `v${i}`);
    }
    const snapshots = await storage.listSnapshots('doc1');
    expect(snapshots).toHaveLength(HISTORY_LIMIT);
    expect(snapshots[0].label).toBe(`v${HISTORY_LIMIT + 3}`); // newest first
    expect(snapshots.every((s) => s.sizeBytes > 0 && s.createdAt > 0)).toBe(true);

    // Snapshot state is retrievable and decodes to the right content.
    const state = await storage.getSnapshotState(snapshots[0].id, 'doc1');
    const replica = new Y.Doc();
    Y.applyUpdate(replica, state!);
    expect(replica.getText('t').toString()).toBe(`version ${HISTORY_LIMIT + 3}`);

    // getLatestSnapshotState matches the head of the list.
    const latest = await storage.getLatestSnapshotState('doc1');
    expect(Buffer.from(latest!).equals(Buffer.from(state!))).toBe(true);
  });

  it('scopes snapshots to their document', async () => {
    await storage.createDocument({ id: 'doc2', title: 'Other', ownerId: 'u1' });
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'doc1 content');
    const meta = await storage.addSnapshot('doc1', Y.encodeStateAsUpdate(doc));
    expect(await storage.getSnapshotState(meta.id, 'doc2')).toBeNull();
    expect(await storage.listSnapshots('doc2')).toHaveLength(0);
  });

  it('deleting a document removes state, snapshots and shares', async () => {
    const other = await storage.createUser({ id: 'u2', email: 'b@b.c', name: 'B', passwordHash: 'x' });
    await storage.upsertShare('doc1', other.id, 'editor');
    const doc = new Y.Doc();
    doc.getText('t').insert(0, 'bye');
    await storage.saveState('doc1', Y.encodeStateAsUpdate(doc));
    await storage.addSnapshot('doc1', Y.encodeStateAsUpdate(doc));

    await storage.deleteDocument('doc1');

    expect(await storage.getDocument('doc1')).toBeNull();
    expect(await storage.loadState('doc1')).toBeNull();
    expect(await storage.listSnapshots('doc1')).toHaveLength(0);
    expect(await storage.getRole('doc1', other.id)).toBeNull();
  });
});
