const PALETTE = [
  '#e8590c',
  '#1c7ed6',
  '#0ca678',
  '#7048e8',
  '#d6336c',
  '#74b816',
  '#f59f00',
  '#22b8cf',
];

/** Deterministic presence color per user id. */
export function colorForUser(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}
