export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000/api';
export const WS_URL: string = (import.meta.env.VITE_WS_URL as string | undefined) ?? 'ws://localhost:4000/ws';

export interface User {
  id: string;
  email: string;
  name: string;
}

export type Role = 'viewer' | 'editor' | 'owner';

export interface DocMeta {
  id: string;
  title: string;
  ownerId: string;
  createdAt: number;
  updatedAt: number;
  role: Role;
}

export interface ShareEntry {
  documentId: string;
  userId: string;
  permission: 'viewer' | 'editor';
  email: string;
  name: string;
}

export interface SnapshotMeta {
  id: string;
  documentId: string;
  label: string | null;
  createdAt: number;
  sizeBytes: number;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(
  path: string,
  opts: { method?: string; token?: string | null; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
