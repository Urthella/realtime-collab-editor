import { Router, type Request, type RequestHandler, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { requestUser } from '../auth.js';
import { ROLE_RANK, type DocumentRecord, type Role, type StorageAdapter } from '../storage/types.js';
import type { RoomManager } from '../ws/rooms.js';
import { asyncHandler } from './auth.js';

interface DocContext {
  doc: DocumentRecord;
  role: Role;
}

export interface DocumentsDeps {
  storage: StorageAdapter;
  rooms: RoomManager;
}

export function documentsRouter({ storage, rooms }: DocumentsDeps): Router {
  const router = Router();

  /** Load the document, resolve the caller's role, enforce a minimum role. */
  function withRole(
    minRole: Role,
    handler: (req: Request, res: Response, ctx: DocContext) => Promise<unknown>,
  ): RequestHandler {
    return asyncHandler(async (req, res) => {
      const doc = await storage.getDocument(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Document not found' });
      const role = await storage.getRole(doc.id, requestUser(req).id);
      if (!role) return res.status(403).json({ error: 'You do not have access to this document' });
      if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
        return res.status(403).json({ error: `This action requires ${minRole} access` });
      }
      await handler(req, res, { doc, role });
    });
  }

  // --- CRUD ---

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      res.json(await storage.listDocumentsForUser(requestUser(req).id));
    }),
  );

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawTitle = typeof body.title === 'string' ? body.title.trim() : '';
      const title = rawTitle ? rawTitle.slice(0, 200) : 'Untitled document';
      const doc = await storage.createDocument({ id: randomUUID(), title, ownerId: requestUser(req).id });
      res.status(201).json({ ...doc, role: 'owner' });
    }),
  );

  router.get(
    '/:id',
    withRole('viewer', async (_req, res, ctx) => {
      res.json({ ...ctx.doc, role: ctx.role });
    }),
  );

  router.patch(
    '/:id',
    withRole('owner', async (req, res, ctx) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
      if (!title) return res.status(400).json({ error: 'A non-empty title is required' });
      await storage.renameDocument(ctx.doc.id, title);
      const updated = await storage.getDocument(ctx.doc.id);
      res.json({ ...updated, role: ctx.role });
    }),
  );

  router.delete(
    '/:id',
    withRole('owner', async (_req, res, ctx) => {
      await rooms.closeRoom(ctx.doc.id);
      await storage.deleteDocument(ctx.doc.id);
      res.status(204).end();
    }),
  );

  // --- sharing ---

  router.get(
    '/:id/shares',
    withRole('owner', async (_req, res, ctx) => {
      res.json(await storage.listShares(ctx.doc.id));
    }),
  );

  router.put(
    '/:id/shares',
    withRole('owner', async (req, res, ctx) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const permission = body.permission;
      if (permission !== 'viewer' && permission !== 'editor') {
        return res.status(400).json({ error: "permission must be 'viewer' or 'editor'" });
      }
      const target = await storage.getUserByEmail(email);
      if (!target) return res.status(404).json({ error: 'No registered user with that email' });
      if (target.id === ctx.doc.ownerId) {
        return res.status(400).json({ error: 'The owner already has full access' });
      }
      await storage.upsertShare(ctx.doc.id, target.id, permission);
      res.json(await storage.listShares(ctx.doc.id));
    }),
  );

  router.delete(
    '/:id/shares/:userId',
    withRole('owner', async (req, res, ctx) => {
      await storage.removeShare(ctx.doc.id, req.params.userId);
      res.json(await storage.listShares(ctx.doc.id));
    }),
  );

  // --- version history ---

  router.get(
    '/:id/snapshots',
    withRole('viewer', async (_req, res, ctx) => {
      res.json(await storage.listSnapshots(ctx.doc.id));
    }),
  );

  router.post(
    '/:id/snapshots',
    withRole('editor', async (req, res, ctx) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : null;
      let state = await rooms.getCurrentState(ctx.doc.id);
      if (!state) state = Y.encodeStateAsUpdate(new Y.Doc());
      const meta = await storage.addSnapshot(ctx.doc.id, state, label);
      res.status(201).json(meta);
    }),
  );

  router.post(
    '/:id/snapshots/:snapshotId/restore',
    withRole('editor', async (req, res, ctx) => {
      const snapshotState = await storage.getSnapshotState(req.params.snapshotId, ctx.doc.id);
      if (!snapshotState) return res.status(404).json({ error: 'Snapshot not found' });
      // Safety net: snapshot the current content before overwriting it.
      const current = await rooms.getCurrentState(ctx.doc.id);
      if (current && current.byteLength > 2) {
        await storage.addSnapshot(ctx.doc.id, current, 'auto — before restore');
      }
      await rooms.restoreSnapshot(ctx.doc.id, snapshotState);
      await storage.touchDocument(ctx.doc.id);
      res.json({ ok: true });
    }),
  );

  return router;
}
