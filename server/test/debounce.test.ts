import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { DebouncedSaver } from '../src/ws/saver.js';
import { RoomManager } from '../src/ws/rooms.js';
import { createSqliteStorage } from '../src/storage/sqlite.js';
import { FakeSocket } from './helpers.js';

describe('DebouncedSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a burst of changes into a single save after the debounce window', async () => {
    const save = vi.fn(async () => {});
    const saver = new DebouncedSaver(save, 2000);

    for (let i = 0; i < 25; i++) saver.markDirty(); // simulated keystrokes
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1999);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('saves at most once per window during continuous activity', async () => {
    const save = vi.fn(async () => {});
    const saver = new DebouncedSaver(save, 2000);

    // 10 seconds of nonstop typing: a keystroke every 100ms.
    for (let t = 0; t < 100; t++) {
      saver.markDirty();
      await vi.advanceTimersByTimeAsync(100);
    }
    // 10s / 2s window => 5 saves, not 100.
    expect(save).toHaveBeenCalledTimes(5);
  });

  it('flush() persists pending changes immediately', async () => {
    const save = vi.fn(async () => {});
    const saver = new DebouncedSaver(save, 2000);

    saver.markDirty();
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);

    // Nothing dirty -> flush is a no-op.
    await saver.flush();
    expect(save).toHaveBeenCalledTimes(1);

    // The pending timer was cancelled by flush; no double save later.
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('RoomManager persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Let pending microtasks (async close/flush chains) settle without firing intervals. */
  async function settle() {
    await vi.advanceTimersByTimeAsync(1);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }

  async function setup() {
    const storage = await createSqliteStorage(':memory:', 5);
    const user = await storage.createUser({ id: 'u1', email: 'a@b.c', name: 'A', passwordHash: 'x' });
    const doc = await storage.createDocument({ id: 'doc1', title: 'T', ownerId: user.id });
    const rooms = new RoomManager(storage, { debounceMs: 2000 });
    return { storage, doc, rooms };
  }

  it('does not write on every change; persists after the debounce window', async () => {
    const { storage, doc, rooms } = await setup();
    const room = await rooms.getRoom(doc.id);
    const socket = new FakeSocket();
    await rooms.connect(doc.id, socket, true);

    const text = room.doc.getText('scratch');
    for (let i = 0; i < 20; i++) text.insert(text.length, 'x'); // 20 updates

    expect(await storage.loadState(doc.id)).toBeNull(); // nothing hit the DB yet

    await vi.advanceTimersByTimeAsync(2100);
    const persisted = await storage.loadState(doc.id);
    expect(persisted).not.toBeNull();

    const replica = new Y.Doc();
    Y.applyUpdate(replica, persisted!);
    expect(replica.getText('scratch').toString()).toBe('x'.repeat(20));
  });

  it('flushes and snapshots when the last client disconnects', async () => {
    const { storage, doc, rooms } = await setup();
    const room = await rooms.getRoom(doc.id);
    const socket = new FakeSocket();
    await rooms.connect(doc.id, socket, true);

    room.doc.getText('scratch').insert(0, 'unsaved edit');
    expect(await storage.loadState(doc.id)).toBeNull();

    socket.close(); // last client leaves before the debounce window elapses
    await settle();

    const persisted = await storage.loadState(doc.id);
    expect(persisted).not.toBeNull();
    const replica = new Y.Doc();
    Y.applyUpdate(replica, persisted!);
    expect(replica.getText('scratch').toString()).toBe('unsaved edit');

    const snapshots = await storage.listSnapshots(doc.id);
    expect(snapshots.length).toBe(1);
    expect(rooms.hasActiveRoom(doc.id)).toBe(false); // room unloaded from memory
  });

  it('keeps the room loaded while other clients remain connected', async () => {
    const { doc, rooms } = await setup();
    const a = new FakeSocket();
    const b = new FakeSocket();
    await rooms.connect(doc.id, a, true);
    await rooms.connect(doc.id, b, false);

    a.close();
    await settle();
    expect(rooms.hasActiveRoom(doc.id)).toBe(true);

    b.close();
    await settle();
    expect(rooms.hasActiveRoom(doc.id)).toBe(false);
  });
});
