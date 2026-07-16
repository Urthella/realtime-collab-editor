import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { StorageAdapter } from '../storage/types.js';
import { DebouncedSaver } from './saver.js';

// y-websocket wire protocol message types (must match the client).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const PING_INTERVAL_MS = 30_000;

/** Name of the shared type Tiptap's Collaboration extension binds to. */
export const DOC_FRAGMENT_FIELD = 'default';

/**
 * Minimal socket surface required by the room manager. `ws.WebSocket`
 * satisfies this structurally; tests use a lightweight fake.
 */
export interface SocketLike {
  readyState: number;
  send(data: Uint8Array, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: string, listener: (...args: never[]) => void): void;
  ping?(): void;
  terminate?(): void;
}

interface ConnInfo {
  canWrite: boolean;
  controlledIds: Set<number>;
  pongReceived: boolean;
  pingTimer: NodeJS.Timeout | null;
}

export class Room {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  readonly conns = new Map<SocketLike, ConnInfo>();
  readonly saver: DebouncedSaver;

  constructor(save: () => Promise<void>, debounceMs: number) {
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server itself has no presence
    this.saver = new DebouncedSaver(save, debounceMs);
  }

  destroy(): void {
    this.saver.dispose();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** An encoded update of an empty Y.Doc is 2 bytes — treat that as "no content". */
function isEmptyState(state: Uint8Array): boolean {
  return state.byteLength <= 2;
}

/**
 * Owns one in-memory Y.Doc ("room") per open document, speaks the
 * y-protocols sync/awareness wire protocol with clients, enforces write
 * permission per connection, and persists via debounced snapshotting.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Promise<Room>>();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly opts: { debounceMs: number },
  ) {}

  /** Load (or reuse) the room for a document. */
  getRoom(docId: string): Promise<Room> {
    let pending = this.rooms.get(docId);
    if (!pending) {
      pending = this.loadRoom(docId).catch((err) => {
        this.rooms.delete(docId);
        throw err;
      });
      this.rooms.set(docId, pending);
    }
    return pending;
  }

  hasActiveRoom(docId: string): boolean {
    return this.rooms.has(docId);
  }

  private async loadRoom(docId: string): Promise<Room> {
    const room: Room = new Room(async () => {
      const state = Y.encodeStateAsUpdate(room.doc);
      await this.storage.saveState(docId, state);
    }, this.opts.debounceMs);

    const persisted = await this.storage.loadState(docId);
    if (persisted) Y.applyUpdate(room.doc, persisted);

    // Broadcast document updates to every other connection + schedule a save.
    room.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const conn of room.conns.keys()) {
        if (conn !== origin) this.send(conn, message);
      }
      room.saver.markDirty();
    });

    // Relay awareness (presence/cursor) changes to everyone.
    room.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = added.concat(updated, removed);
        const originConn = origin as SocketLike;
        const info = room.conns.get(originConn);
        if (info) {
          for (const id of added) info.controlledIds.add(id);
          for (const id of removed) info.controlledIds.delete(id);
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed));
        const message = encoding.toUint8Array(encoder);
        for (const conn of room.conns.keys()) this.send(conn, message);
      },
    );

    return room;
  }

  /** Attach an (already authenticated + authorized) WebSocket to a room. */
  async connect(docId: string, ws: SocketLike, canWrite: boolean): Promise<void> {
    const room = await this.getRoom(docId);
    const info: ConnInfo = { canWrite, controlledIds: new Set(), pongReceived: true, pingTimer: null };
    room.conns.set(ws, info);

    ws.on('message', ((data: Uint8Array) => {
      try {
        this.handleMessage(room, ws, info, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      } catch (err) {
        console.error(`[ws] failed to handle message for doc ${docId}:`, err);
      }
    }) as never);
    ws.on('close', (() => {
      void this.closeConn(docId, room, ws);
    }) as never);
    ws.on('error', (() => {
      void this.closeConn(docId, room, ws);
    }) as never);
    ws.on('pong', (() => {
      info.pongReceived = true;
    }) as never);

    // Keepalive: terminate zombie connections that stop answering pings.
    info.pingTimer = setInterval(() => {
      if (!room.conns.has(ws)) return;
      if (!info.pongReceived) {
        if (ws.terminate) ws.terminate();
        else ws.close();
        return;
      }
      info.pongReceived = false;
      try {
        ws.ping?.();
      } catch {
        void this.closeConn(docId, room, ws);
      }
    }, PING_INTERVAL_MS);

    // Handshake: send SyncStep1 (our state vector) + current awareness states.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    this.send(ws, encoding.toUint8Array(encoder));

    const states = room.awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]),
      );
      this.send(ws, encoding.toUint8Array(awarenessEncoder));
    }
  }

  private handleMessage(room: Room, ws: SocketLike, info: ConnInfo, data: Uint8Array): void {
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case MESSAGE_SYNC: {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        const syncType = decoding.readVarUint(decoder);
        switch (syncType) {
          case syncProtocol.messageYjsSyncStep1:
            // Client asks for what it is missing — always allowed.
            syncProtocol.readSyncStep1(decoder, encoder, room.doc);
            break;
          case syncProtocol.messageYjsSyncStep2:
            // Client pushes state — only if it has write permission.
            if (info.canWrite) syncProtocol.readSyncStep2(decoder, room.doc, ws);
            break;
          case syncProtocol.messageYjsUpdate:
            if (info.canWrite) syncProtocol.readUpdate(decoder, room.doc, ws);
            break;
        }
        if (encoding.length(encoder) > 1) this.send(ws, encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws);
        break;
      }
      default:
        break; // ignore unknown message types
    }
  }

  private async closeConn(docId: string, room: Room, ws: SocketLike): Promise<void> {
    const info = room.conns.get(ws);
    if (!info) return;
    room.conns.delete(ws);
    if (info.pingTimer) clearInterval(info.pingTimer);
    awarenessProtocol.removeAwarenessStates(room.awareness, [...info.controlledIds], null);
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    if (room.conns.size === 0) {
      // Last client left: persist immediately, add a history snapshot, unload.
      await room.saver.flush();
      if (room.conns.size === 0 && this.rooms.has(docId)) {
        this.rooms.delete(docId);
        await this.addDisconnectSnapshot(docId, room);
        room.destroy();
      }
    }
  }

  private async addDisconnectSnapshot(docId: string, room: Room): Promise<void> {
    try {
      const state = Y.encodeStateAsUpdate(room.doc);
      if (isEmptyState(state)) return;
      const latest = await this.storage.getLatestSnapshotState(docId);
      if (latest && bytesEqual(latest, state)) return; // nothing changed since last snapshot
      await this.storage.addSnapshot(docId, state, 'auto — session ended');
    } catch (err) {
      console.error(`[persistence] failed to snapshot doc ${docId} on disconnect:`, err);
    }
  }

  /** Current full document state (live room if loaded, otherwise persisted). */
  async getCurrentState(docId: string): Promise<Uint8Array | null> {
    const pending = this.rooms.get(docId);
    if (pending) {
      const room = await pending;
      await room.saver.flush();
      return Y.encodeStateAsUpdate(room.doc);
    }
    return this.storage.loadState(docId);
  }

  /**
   * Restore a snapshot as a *new edit*: the snapshot's content replaces the
   * live fragment inside one Yjs transaction, so connected clients converge
   * on the restored content without losing CRDT history linearity.
   */
  async restoreSnapshot(docId: string, snapshotState: Uint8Array): Promise<void> {
    const hadRoom = this.rooms.has(docId);
    const room = await this.getRoom(docId);
    const snapshotDoc = new Y.Doc();
    Y.applyUpdate(snapshotDoc, snapshotState);
    const source = snapshotDoc.getXmlFragment(DOC_FRAGMENT_FIELD);
    const target = room.doc.getXmlFragment(DOC_FRAGMENT_FIELD);
    room.doc.transact(() => {
      if (target.length > 0) target.delete(0, target.length);
      const clones = source.toArray().map((node) => node.clone());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      target.insert(0, clones as any);
    }, 'snapshot-restore');
    snapshotDoc.destroy();
    await room.saver.flush();
    if (!hadRoom && room.conns.size === 0) {
      this.rooms.delete(docId);
      room.destroy();
    }
  }

  /** Force-close a room (e.g. the document was deleted), kicking all clients. */
  async closeRoom(docId: string, code = 4404, reason = 'document deleted'): Promise<void> {
    const pending = this.rooms.get(docId);
    if (!pending) return;
    this.rooms.delete(docId);
    const room = await pending;
    for (const [conn, info] of room.conns) {
      if (info.pingTimer) clearInterval(info.pingTimer);
      try {
        conn.close(code, reason);
      } catch {
        /* ignore */
      }
    }
    room.conns.clear();
    room.destroy();
  }

  /** Flush every dirty room (used on graceful shutdown). */
  async shutdown(): Promise<void> {
    const pendings = [...this.rooms.values()];
    for (const pending of pendings) {
      try {
        const room = await pending;
        await room.saver.flush();
      } catch (err) {
        console.error('[persistence] flush on shutdown failed:', err);
      }
    }
  }

  private send(ws: SocketLike, data: Uint8Array): void {
    if (ws.readyState !== WS_CONNECTING && ws.readyState !== WS_OPEN) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      ws.send(data, (err) => {
        if (err) {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }
      });
    } catch {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}
