import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type ShareEntry } from '../api';

interface Props {
  docId: string;
  token: string;
  onClose: () => void;
}

export default function ShareDialog({ docId, token, onClose }: Props) {
  const [shares, setShares] = useState<ShareEntry[] | null>(null);
  const [email, setEmail] = useState('');
  const [permission, setPermission] = useState<'viewer' | 'editor'>('editor');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setShares(await api<ShareEntry[]>(`/documents/${docId}/shares`, { token }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load shares');
    }
  }, [docId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addShare(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const updated = await api<ShareEntry[]>(`/documents/${docId}/shares`, {
        method: 'PUT',
        token,
        body: { email, permission },
      });
      setShares(updated);
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to share');
    } finally {
      setBusy(false);
    }
  }

  async function removeShare(userId: string) {
    try {
      setShares(await api<ShareEntry[]>(`/documents/${docId}/shares/${userId}`, { method: 'DELETE', token }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove share');
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Share document</h3>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        <form className="share-form" onSubmit={addShare}>
          <input
            type="email"
            placeholder="teammate@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <select value={permission} onChange={(e) => setPermission(e.target.value as 'viewer' | 'editor')}>
            <option value="editor">can edit</option>
            <option value="viewer">can view</option>
          </select>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            Share
          </button>
        </form>

        <div className="share-list">
          {shares === null ? (
            <p className="muted">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="muted">Not shared with anyone yet.</p>
          ) : (
            shares.map((share) => (
              <div key={share.userId} className="share-row">
                <span className="share-who">
                  <strong>{share.name}</strong> <span className="muted">{share.email}</span>
                </span>
                <span className={`role-badge role-${share.permission}`}>{share.permission}</span>
                <button className="btn btn-ghost btn-danger" onClick={() => void removeShare(share.userId)}>
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
