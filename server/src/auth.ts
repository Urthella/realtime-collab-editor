import jwt from 'jsonwebtoken';
import type { Request, RequestHandler } from 'express';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

export interface AuthedRequest extends Request {
  user: AuthUser;
}

const TOKEN_TTL = '7d';

export function signToken(user: AuthUser, secret: string): string {
  return jwt.sign({ sub: user.id, email: user.email, name: user.name }, secret, {
    expiresIn: TOKEN_TTL,
  });
}

export function verifyToken(token: string, secret: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, secret);
    if (typeof payload === 'string' || typeof payload.sub !== 'string') return null;
    return {
      id: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      name: typeof payload.name === 'string' ? payload.name : '',
    };
  } catch {
    return null;
  }
}

/** Express middleware: requires a valid `Authorization: Bearer <jwt>` header. */
export function authMiddleware(secret: string): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const user = token ? verifyToken(token, secret) : null;
    if (!user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    (req as AuthedRequest).user = user;
    next();
  };
}

export function requestUser(req: Request): AuthUser {
  return (req as AuthedRequest).user;
}
