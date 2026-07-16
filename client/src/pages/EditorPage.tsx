import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { api, WS_URL, type DocMeta } from '../api';
import { useSession } from '../auth';
import { colorForUser } from '../colors';
import ConnectionStatus, { type ConnState } from '../components/ConnectionStatus';
import PresenceBar, { type Peer } from '../components/PresenceBar';
import ShareDialog from '../components/ShareDialog';
import HistoryPanel from '../components/HistoryPanel';
import Toolbar from '../components/Toolbar';

interface Collab {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
}

export default function EditorPage() {
  const { id: docId } = useParams<{ id: string }>();
  const { token, user } = useSession();

  const [meta, setMeta] = useState<DocMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [collab, setCollab] = useState<Collab | null>(null);
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [peers, setPeers] = useState<Peer[]>([]);
  const [showShare, setShowShare] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Document metadata (title, my role).
  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    api<DocMeta>(`/documents/${docId}`, { token })
      .then((doc) => {
        if (!cancelled) setMeta(doc);
      })
      .catch((err: Error) => {
        if (!cancelled) setMetaError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [docId, token]);

  // Yjs document + y-websocket provider lifecycle.
  useEffect(() => {
    if (!docId) return;
    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(WS_URL, docId, ydoc, {
      params: { token },
      disableBc: true,
    });

    provider.on('status', ({ status }: { status: 'connecting' | 'connected' | 'disconnected' }) => {
      setConnState(status);
    });
    provider.on('connection-close', (event: CloseEvent | null) => {
      // Application close codes (4xxx) mean "don't retry": auth/permission
      // failure or the document was deleted.
      if (event && event.code >= 4000) {
        provider.disconnect();
        setConnState('denied');
      }
    });

    setCollab({ ydoc, provider });
    return () => {
      setCollab(null);
      provider.destroy();
      ydoc.destroy();
    };
  }, [docId, token]);

  // Presence list derived from Yjs awareness.
  useEffect(() => {
    if (!collab) return;
    const awareness = collab.provider.awareness;
    const refresh = () => {
      const list: Peer[] = [];
      awareness.getStates().forEach((state, clientId) => {
        const u = (state as { user?: { name?: string; color?: string } }).user;
        if (!u?.name) return;
        list.push({
          clientId,
          name: u.name,
          color: u.color ?? '#888',
          isSelf: clientId === awareness.clientID,
        });
      });
      list.sort((a, b) => (a.isSelf === b.isSelf ? a.clientId - b.clientId : a.isSelf ? -1 : 1));
      setPeers(list);
    };
    awareness.on('change', refresh);
    refresh();
    return () => awareness.off('change', refresh);
  }, [collab]);

  if (!docId) return null;
  if (metaError) {
    return (
      <div className="page">
        <header className="topbar">
          <Link className="brand" to="/">
            Loop
          </Link>
        </header>
        <main className="editor-error">
          <p className="form-error">{metaError}</p>
          <Link to="/">Back to your documents</Link>
        </main>
      </div>
    );
  }

  const canEdit = meta ? meta.role === 'owner' || meta.role === 'editor' : false;

  return (
    <div className="page editor-page">
      <header className="topbar">
        <div className="topbar-left">
          <Link className="brand" to="/">
            Loop
          </Link>
          <span className="doc-heading" title={meta?.title}>
            {meta?.title ?? 'Loading…'}
          </span>
          {meta && <span className={`role-badge role-${meta.role}`}>{meta.role}</span>}
        </div>
        <div className="topbar-right">
          <ConnectionStatus state={connState} />
          <PresenceBar peers={peers} />
          <button className="btn btn-ghost" onClick={() => setShowHistory((v) => !v)}>
            History
          </button>
          {meta?.role === 'owner' && (
            <button className="btn btn-primary" onClick={() => setShowShare(true)}>
              Share
            </button>
          )}
        </div>
      </header>

      <div className="editor-layout">
        <main className="editor-main">
          {collab && meta ? (
            <BoundEditor
              key={docId}
              collab={collab}
              canEdit={canEdit}
              userName={user.name}
              userColor={colorForUser(user.id)}
            />
          ) : (
            <p className="muted editor-loading">Loading document…</p>
          )}
        </main>
        {showHistory && <HistoryPanel docId={docId} token={token} canEdit={canEdit} />}
      </div>

      {showShare && <ShareDialog docId={docId} token={token} onClose={() => setShowShare(false)} />}
    </div>
  );
}

interface BoundEditorProps {
  collab: Collab;
  canEdit: boolean;
  userName: string;
  userColor: string;
}

function BoundEditor({ collab, canEdit, userName, userColor }: BoundEditorProps) {
  const extensions = useMemo(
    () => [
      // Collaboration ships its own Yjs-aware history; disable the default.
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: collab.ydoc, field: 'default' }),
      CollaborationCursor.configure({
        provider: collab.provider,
        user: { name: userName, color: userColor },
      }),
    ],
    [collab, userName, userColor],
  );

  const editor = useEditor(
    {
      extensions,
      editable: canEdit,
      editorProps: {
        attributes: { class: 'tiptap-editor' },
      },
    },
    [extensions],
  );

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  if (!editor) return null;

  return (
    <div className="editor-frame">
      <Toolbar editor={editor} />
      {!canEdit && <div className="readonly-banner">Read-only — you have viewer access.</div>}
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}
