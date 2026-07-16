import http from 'node:http';
import { WebSocketServer } from 'ws';
import { loadConfig } from './config.js';
import { createStorage } from './storage/index.js';
import { RoomManager, type SocketLike } from './ws/rooms.js';
import { resolveWsAccess } from './ws/auth.js';
import { createApp } from './app.js';

const WS_PATH_RE = /^\/ws\/([A-Za-z0-9_-]+)$/;

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = await createStorage(config);
  const rooms = new RoomManager(storage, { debounceMs: config.snapshotDebounceMs });
  const app = createApp({ storage, rooms, config });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  // Yjs sync endpoint: ws://host:port/ws/<documentId>?token=<jwt>
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const match = WS_PATH_RE.exec(url.pathname);
        if (!match) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }
        const docId = match[1];
        const access = await resolveWsAccess(storage, config.jwtSecret, url.searchParams.get('token'), docId);
        if (!access) {
          // Complete the handshake, then close with an application code the
          // client can distinguish from a network failure (stops retry loops).
          wss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'not authorized for this document'));
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          void rooms.connect(docId, ws as unknown as SocketLike, access.canWrite).catch((err) => {
            console.error(`[ws] failed to attach connection for doc ${docId}:`, err);
            ws.close(1011, 'internal error');
          });
        });
      } catch (err) {
        console.error('[ws] upgrade failed:', err);
        socket.destroy();
      }
    })();
  });

  server.listen(config.port, () => {
    console.log(`[server] listening on http://localhost:${config.port}`);
    console.log(`[server] REST API:   http://localhost:${config.port}/api`);
    console.log(`[server] Yjs sync:   ws://localhost:${config.port}/ws/<docId>?token=<jwt>`);
    console.log(`[server] storage:    ${config.databaseUrl ? 'postgres' : `sqlite (${config.sqlitePath})`}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, flushing documents and shutting down...`);
    void (async () => {
      try {
        await rooms.shutdown();
        await storage.close();
      } catch (err) {
        console.error('[server] error during shutdown:', err);
      } finally {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
      }
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] fatal startup error:', err);
  process.exit(1);
});
