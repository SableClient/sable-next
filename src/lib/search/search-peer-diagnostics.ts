export interface SearchPeerConnection {
  sessionId: string;
  sending: boolean;
  state: RTCPeerConnectionState;
  route: RTCIceCandidateType | null;
}

const MAX_CONNECTIONS = 4;

const connections: SearchPeerConnection[] = [];
const listeners = new Set<(connections: SearchPeerConnection[]) => void>();

function snapshot(): SearchPeerConnection[] {
  return connections.map((connection) => ({ ...connection }));
}

export function watchSearchPeerConnections(
  listener: (connections: SearchPeerConnection[]) => void
): () => void {
  listener(snapshot());
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function reportSearchPeerConnection(connection: SearchPeerConnection): void {
  const index = connections.findIndex((known) => known.sessionId === connection.sessionId);
  if (index >= 0) connections[index] = connection;
  else connections.unshift(connection);
  connections.splice(MAX_CONNECTIONS);
  for (const listener of listeners) listener(snapshot());
}

interface Stat {
  type: string;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  candidateType?: RTCIceCandidateType;
  nominated?: boolean;
  state?: string;
}

export async function selectedRoute(peer: RTCPeerConnection): Promise<RTCIceCandidateType | null> {
  const stats = await peer.getStats();
  const reports = [...stats.values()] as Stat[];
  const find = (id: string | undefined): Stat | undefined =>
    id === undefined ? undefined : (stats.get(id) as Stat | undefined);
  const pair =
    find(reports.find((report) => report.selectedCandidatePairId)?.selectedCandidatePairId) ??
    reports.find(
      (report) =>
        report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded'
    );
  return find(pair?.localCandidateId)?.candidateType ?? null;
}
