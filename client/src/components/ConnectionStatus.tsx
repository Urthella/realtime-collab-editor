export type ConnState = 'connecting' | 'connected' | 'disconnected' | 'denied';

const LABELS: Record<ConnState, string> = {
  connecting: 'Connecting…',
  connected: 'Live',
  disconnected: 'Offline — reconnecting',
  denied: 'Access denied',
};

export default function ConnectionStatus({ state }: { state: ConnState }) {
  return (
    <span className={`conn-status conn-${state}`} title={`Sync status: ${LABELS[state]}`}>
      <span className="conn-dot" />
      {LABELS[state]}
    </span>
  );
}
