import type { CoreEvent, Rpc, RtcPurpose, RtcSignal } from '#src/generated/protocol';

const MAX_SDP_BYTES = 48 * 1024;
const MAX_PENDING_CANDIDATES = 64;

export type RtcEvent = Extract<CoreEvent, { type: 'rtc' }>;

export function isRtcEvent(event: CoreEvent, purpose: RtcPurpose): event is RtcEvent {
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- search sharing is the only purpose so far
  return event.type === 'rtc' && event.purpose === purpose;
}

export interface RtcCore {
  rpc: { rtc: Pick<Rpc['rtc'], 'signal' | 'close'> };
}

export interface RtcConnection {
  peer: RTCPeerConnection;
  receive(event: RtcEvent): Promise<void>;
  close(): void;
}

export async function iceServers(
  stunServers: string[],
  turnServer: () => Promise<{ uris: string[]; username: string; password: string }>
): Promise<RTCIceServer[]> {
  const servers: RTCIceServer[] = stunServers.map((urls) => ({ urls }));
  const turn = await turnServer().catch(() => null);
  if (turn?.uris.length)
    servers.push({ urls: turn.uris, username: turn.username, credential: turn.password });
  return servers;
}

export function connectRtc(
  core: RtcCore,
  {
    sessionId,
    sender,
    iceServers,
  }: { sessionId: string; sender: boolean; iceServers: RTCIceServer[] },
  onClose: () => void
): RtcConnection {
  const peer = new RTCPeerConnection({ iceServers });
  const pending: RTCIceCandidateInit[] = [];
  let closed = false;
  let incoming = Promise.resolve();
  let outgoing = Promise.resolve();

  function close(): void {
    if (closed) return;
    closed = true;
    peer.close();
    void core.rpc.rtc.close({ session_id: sessionId }).catch(() => {});
    onClose();
  }

  function signal(next: RtcSignal): void {
    outgoing = outgoing
      .then(async () => {
        if (!closed) await core.rpc.rtc.signal({ session_id: sessionId, signal: next });
      })
      .catch(close);
  }

  async function describe(): Promise<void> {
    await peer.setLocalDescription();
    const description = peer.localDescription;
    if (closed || !description) return;
    if (description.type !== 'offer' && description.type !== 'answer') return;
    signal({ kind: 'negotiate', description: { type: description.type, sdp: description.sdp } });
  }

  async function apply(next: RtcSignal): Promise<void> {
    if (next.kind === 'close') {
      close();
    } else if (next.kind === 'negotiate') {
      const { description } = next;
      if (description.type !== (sender ? 'answer' : 'offer')) throw new Error('wrong role');
      if (description.sdp.length > MAX_SDP_BYTES) throw new Error('oversized description');
      await peer.setRemoteDescription(description);
      for (const candidate of pending.splice(0)) await peer.addIceCandidate(candidate);
      if (!sender) await describe();
    } else if (next.kind === 'candidate') {
      if (peer.remoteDescription) await peer.addIceCandidate(next.candidate);
      else if (pending.length < MAX_PENDING_CANDIDATES) pending.push(next.candidate);
      else throw new Error('too many candidates');
    }
  }

  peer.addEventListener('icecandidate', ({ candidate }) => {
    if (!candidate?.candidate) return;
    signal({
      kind: 'candidate',
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      },
    });
  });
  if (sender) {
    peer.addEventListener('negotiationneeded', () => {
      incoming = incoming.then(describe).catch(close);
    });
  }
  peer.addEventListener('connectionstatechange', () => {
    if (peer.connectionState === 'failed' || peer.connectionState === 'closed') close();
  });

  return {
    peer,
    close,
    receive(event: RtcEvent): Promise<void> {
      incoming = incoming.then(async () => {
        if (closed || event.sender !== sender) {
          close();
          return;
        }
        await apply(event.signal);
      });
      return incoming;
    },
  };
}
