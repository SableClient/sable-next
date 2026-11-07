// @vitest-environment happy-dom

import { beforeEach, expect, test, vi } from 'vitest';

import { connectRtc, iceServers, type RtcCore, type RtcEvent } from './connect';

class Peer extends EventTarget {
  static last: Peer;
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  addIceCandidate = vi.fn(() => Promise.resolve());
  setLocalDescription = vi.fn(() => {
    this.localDescription = {
      type: this.remoteDescription?.type === 'offer' ? 'answer' : 'offer',
      sdp: 'local',
    };
    return Promise.resolve();
  });
  setRemoteDescription = vi.fn((description: { type: string; sdp: string }) => {
    this.remoteDescription = description;
    return Promise.resolve();
  });
  close = vi.fn();
  constructor(readonly config: RTCConfiguration) {
    super();
    Peer.last = this;
  }
}

let core: RtcCore;
const candidate = { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 };

function event(signal: RtcEvent['signal'], sender: boolean): RtcEvent {
  return { type: 'rtc', purpose: 'search_sharing', session_id: 's', sender, signal };
}

beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', Peer);
  core = {
    rpc: {
      rtc: {
        signal: vi.fn(() => Promise.resolve(null)),
        close: vi.fn(() => Promise.resolve(null)),
      },
    },
  };
});

test('the sender offers on negotiationneeded and trickles candidates', async () => {
  connectRtc(core, { sessionId: 's', sender: true, iceServers: [] }, () => {});
  Peer.last.dispatchEvent(new Event('negotiationneeded'));
  Peer.last.dispatchEvent(Object.assign(new Event('icecandidate'), { candidate }));
  await vi.waitFor(() => {
    expect(core.rpc.rtc.signal).toHaveBeenCalledWith({
      session_id: 's',
      signal: { kind: 'negotiate', description: { type: 'offer', sdp: 'local' } },
    });
    expect(core.rpc.rtc.signal).toHaveBeenCalledWith({
      session_id: 's',
      signal: { kind: 'candidate', candidate },
    });
  });
});

test('the receiver queues early candidates and answers every offer', async () => {
  const rtc = connectRtc(core, { sessionId: 's', sender: false, iceServers: [] }, () => {});
  void rtc.receive(event({ kind: 'candidate', candidate }, false));
  void rtc.receive(event({ kind: 'negotiate', description: { type: 'offer', sdp: 'a' } }, false));
  await rtc.receive(event({ kind: 'negotiate', description: { type: 'offer', sdp: 'b' } }, false));
  expect(Peer.last.addIceCandidate).toHaveBeenCalledWith(candidate);
  expect(Peer.last.setLocalDescription).toHaveBeenCalledTimes(2);
  await vi.waitFor(() => {
    expect(core.rpc.rtc.signal).toHaveBeenCalledWith({
      session_id: 's',
      signal: { kind: 'negotiate', description: { type: 'answer', sdp: 'local' } },
    });
  });
});

test('a description from the wrong role closes the connection', async () => {
  const onClose = vi.fn();
  const rtc = connectRtc(core, { sessionId: 's', sender: false, iceServers: [] }, onClose);
  await rtc
    .receive(event({ kind: 'negotiate', description: { type: 'answer', sdp: 'a' } }, false))
    .catch(() => {
      rtc.close();
    });
  expect(Peer.last.close).toHaveBeenCalledOnce();
  expect(core.rpc.rtc.close).toHaveBeenCalledWith({ session_id: 's' });
  expect(onClose).toHaveBeenCalledOnce();
});

test('a close signal from the core tears the connection down once', async () => {
  const onClose = vi.fn();
  const rtc = connectRtc(core, { sessionId: 's', sender: true, iceServers: [] }, onClose);
  await rtc.receive(event({ kind: 'close' }, true));
  rtc.close();
  expect(Peer.last.close).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
});

test('ICE servers add homeserver TURN credentials to the STUN list', async () => {
  const turn = { uris: ['turn:turn.example'], username: 'u', password: 'p' };
  expect(await iceServers(['stun:a'], () => Promise.resolve(turn))).toEqual([
    { urls: 'stun:a' },
    { urls: ['turn:turn.example'], username: 'u', credential: 'p' },
  ]);
  expect(await iceServers(['stun:a'], () => Promise.reject(new Error('no turn')))).toEqual([
    { urls: 'stun:a' },
  ]);
});
