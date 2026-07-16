import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { authMiddleware, requestUser, signToken } from '../auth.js';
import type { StorageAdapter, UserRecord } from '../storage/types.js';

const BCRYPT_ROUNDS = 10;

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

function publicUser(u: UserRecord): { id: string; email: string; name: string } {
  return { id: u.id, email: u.email, name: u.name };
}

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null;
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 254 || !trimmed.includes('@')) return null;
  return trimmed;
}

export function authRouter(storage: StorageAdapter, jwtSecret: string): Router {
  const router = Router();

  router.post(
    '/register',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = normalizeEmail(body.email);
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';

      if (!email) return res.status(400).json({ error: 'A valid email is required' });
      if (!name || name.length > 80) return res.status(400).json({ error: 'A name (max 80 chars) is required' });
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

      if (await storage.getUserByEmail(email)) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = await storage.createUser({ id: randomUUID(), email, name, passwordHash });
      res.status(201).json({ token: signToken(publicUser(user), jwtSecret), user: publicUser(user) });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = normalizeEmail(body.email);
      const password = typeof body.password === 'string' ? body.password : '';
      const user = email ? await storage.getUserByEmail(email) : null;
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      res.json({ token: signToken(publicUser(user), jwtSecret), user: publicUser(user) });
    }),
  );

  router.get('/me', authMiddleware(jwtSecret), (req, res) => {
    res.json({ user: requestUser(req) });
  });

  return router;
}
