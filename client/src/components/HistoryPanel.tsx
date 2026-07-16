import { useCallback, useEffect, useState } from 'react';
import { api, type SnapshotMeta } from '../api';

interface Props {
  docId: string;
  token: string;
  canEdit: boolean;
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function HistoryPanel({ docId, token, canEdit }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnapshots(await api<SnapshotMeta[]>(`/documents/${docId}/snapshots`, { token }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
    }
  }, [docId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveVersion() {
    setBusy(true);
    setError(null);
    try {
      await api(`/documents/${docId}/snapshots`, {
        method: 'POST',
        token,
        body: { label: label.trim() || undefined },
      });
      setLabel('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save version');
    } finally {
      setBusy(false);
    }
  }

  async function restore(snapshot: SnapshotMeta) {
    const when = formatWhen(snapshot.createdAt);
    if (!window.confirm(`Restore the version from ${when}? Current content is snapshotted first.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/documents/${docId}/snapshots/${snapshot.id}/restore`, { method: 'POST', token, body: {} });
      await load(); // the editor content updates itself through Yjs sync
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="history-panel">
      <h3>Version history</h3>
      {error && <div className="form-error">{error}</div>}

      {canEdit && (
        <div className="history-save">
          <input
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={120}
          />
          <button className="btn btn-primary" onClick={() => void saveVersion()} disabled={busy}>
            Save version
          </button>
        </div>
      )}

      <div className="history-list">
        {snapshots === null ? (
          <p className="muted">Loading…</p>
        ) : snapshots.length === 0 ? (
          <p className="muted">No versions yet. Versions are saved automatically when everyone leaves, or manually here.</p>
        ) : (
          snapshots.map((snapshot) => (
            <div key={snapshot.id} className="history-row">
              <div className="history-meta">
                <span className="history-label">{snapshot.label ?? 'Snapshot'}</span>
                <span className="muted">
                  {formatWhen(snapshot.createdAt)} · {formatSize(snapshot.sizeBytes)}
                </span>
              </div>
              {canEdit && (
                <button className="btn btn-ghost" onClick={() => void restore(snapshot)} disabled={busy}>
                  Restore
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
