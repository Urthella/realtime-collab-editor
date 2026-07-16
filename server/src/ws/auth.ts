import { verifyToken, type AuthUser } from '../auth.js';
import type { Role, StorageAdapter } from '../storage/types.js';

export interface WsAccess {
  user: AuthUser;
  role: Role;
  canWrite: boolean;
}

/**
 * Authenticate a WebSocket connection attempt (JWT from the `token` query
 * param) and authorize it against the document's permissions.
 * Returns null when the connection must be rejected.
 */
export async function resolveWsAccess(
  storage: StorageAdapter,
  jwtSecret: string,
  token: string | null,
  docId: string,
): Promise<WsAccess | null> {
  if (!token) return null;
  const user = verifyToken(token, jwtSecret);
  if (!user) return null;
  const doc = await storage.getDocument(docId);
  if (!doc) return null;
  const role = await storage.getRole(docId, user.id);
  if (!role) return null;
  return { user, role, canWrite: role === 'owner' || role === 'editor' };
}
