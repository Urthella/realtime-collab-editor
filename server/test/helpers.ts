import { EventEmitter } from 'node:events';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { createSqliteStorage } from '../src/storage/sqlite.js';
import type { StorageAdapter } from '../src/storage/types.js';
import { RoomManager, type SocketLike } from '../src/ws/rooms.js';

export const TEST_JWT_SECRET = 'test-secret';

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    jwtSecret: TEST_JWT_SECRET,
    sqlitePath: ':memory:',
    databaseUrl: null,
    snapshotDebounceMs: 2000,
    snapshotHistoryLimit: 5,
    clientOrigin: 'http://localhost:5173',
    ...overrides,
  };
}

export interface TestEnv {
  app: Express;
  storage: StorageAdapter;
  rooms: RoomManager;
  config: ServerConfig;
}

export async function createTestEnv(overrides: Partial<ServerConfig> = {}): Promise<TestEnv> {
  const config = testConfig(overrides);
  const storage = await createSqliteStorage(':memory:', config.snapshotHistoryLimit);
  const rooms = new RoomManager(storage, { debounceMs: config.snapshotDebounceMs });
  const app = createApp({ storage, rooms, config });
  return { app, storage, rooms, config };
}

export interface TestUser {
  token: string;
  user: { id: string; email: string; name: string };
}

export async function registerUser(app: Express, email: string, name = 'Test User'): Promise<TestUser> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email, name, password: 'password123' });
  if (res.status !== 201) throw new Error(`registration failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as TestUser;
}

/** In-process stand-in for a ws.WebSocket, enough for the RoomManager. */
export class FakeSocket extends EventEmitter implements SocketLike {
  readyState = 1; // OPEN
  sent: Uint8Array[] = [];

  send(data: Uint8Array, cb?: (err?: Error) => void): void {
    this.sent.push(data);
    cb?.();
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.emit('close');
  }

  ping(): void {
    /* no-op */
  }

  terminate(): void {
    this.close();
  }
}
