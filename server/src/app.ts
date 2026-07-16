import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { authMiddleware } from './auth.js';
import type { ServerConfig } from './config.js';
import type { StorageAdapter } from './storage/types.js';
import type { RoomManager } from './ws/rooms.js';
import { authRouter } from './routes/auth.js';
import { documentsRouter } from './routes/documents.js';

export interface AppDeps {
  storage: StorageAdapter;
  rooms: RoomManager;
  config: ServerConfig;
}

export function createApp({ storage, rooms, config }: AppDeps): Express {
  const app = express();
  app.use(cors({ origin: config.clientOrigin }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  app.use('/api/auth', authRouter(storage, config.jwtSecret));
  app.use('/api/documents', authMiddleware(config.jwtSecret), documentsRouter({ storage, rooms }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
    console.error('[http] unhandled error:', err);
    res.status(err.status ?? 500).json({ error: 'Internal server error' });
  });

  return app;
}
