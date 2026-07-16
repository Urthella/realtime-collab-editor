import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type DocMeta } from '../api';
import { useAuth, useSession } from '../auth';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function DashboardPage() {
  const { signOut } = useAuth();
  const { token, user } = useSession();
  const navigate = useNavigate();
  const [docs, setDocs] = useState<DocMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const load = useCallback(async () => {
    try {
      setDocs(await api<DocMeta[]>('/documents', { token }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createDoc(e: FormEvent) {
    e.preventDefault();
    try {
      const doc = await api<DocMeta>('/documents', { method: 'POST', token, body: { title: newTitle } });
      setNewTitle('');
      navigate(`/doc/${doc.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create document');
    }
  }

  async function submitRename(docId: string) {
    const title = renameValue.trim();
    setRenamingId(null);
    if (!title) return;
    try {
      await api(`/documents/${docId}`, { method: 'PATCH', token, body: { title } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  }

  async function deleteDoc(doc: DocMeta) {
    if (!window.confirm(`Delete "${doc.title}"? This cannot be undone.`)) return;
    try {
      await api(`/documents/${doc.id}`, { method: 'DELETE', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <span className="brand">Loop</span>
        <div className="topbar-right">
          <span className="muted">{user.name}</span>
          <button className="btn btn-ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="dashboard">
        <h2>Your documents</h2>
        {error && <div className="form-error">{error}</div>}

        <form className="new-doc" onSubmit={createDoc}>
          <input
            placeholder="New document title…"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            maxLength={200}
          />
          <button className="btn btn-primary" type="submit">
            Create
          </button>
        </form>

        {docs === null ? (
          <p className="muted">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="muted">No documents yet — create your first one above.</p>
        ) : (
          <ul className="doc-list">
            {docs.map((doc) => (
              <li key={`${doc.id}-${doc.role}`} className="doc-row">
                {renamingId === doc.id ? (
                  <form
                    className="rename-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void submitRename(doc.id);
                    }}
                  >
                    <input
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      autoFocus
                      maxLength={200}
                      onBlur={() => void submitRename(doc.id)}
                    />
                  </form>
                ) : (
                  <Link className="doc-title" to={`/doc/${doc.id}`}>
                    {doc.title}
                  </Link>
                )}
                <span className={`role-badge role-${doc.role}`}>{doc.role}</span>
                <span className="muted doc-date">edited {formatDate(doc.updatedAt)}</span>
                {doc.role === 'owner' && (
                  <span className="doc-actions">
                    <button
                      className="btn btn-ghost"
                      onClick={() => {
                        setRenamingId(doc.id);
                        setRenameValue(doc.title);
                      }}
                    >
                      Rename
                    </button>
                    <button className="btn btn-ghost btn-danger" onClick={() => void deleteDoc(doc)}>
                      Delete
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
