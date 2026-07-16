import { initials } from '../colors';

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  isSelf: boolean;
}

export default function PresenceBar({ peers }: { peers: Peer[] }) {
  return (
    <div className="presence-bar" title={peers.map((p) => p.name).join(', ')}>
      {peers.map((peer) => (
        <span
          key={peer.clientId}
          className={`avatar${peer.isSelf ? ' avatar-self' : ''}`}
          style={{ backgroundColor: peer.color }}
          title={peer.isSelf ? `${peer.name} (you)` : peer.name}
        >
          {initials(peer.name)}
        </span>
      ))}
      <span className="muted presence-count">
        {peers.length} online
      </span>
    </div>
  );
}
