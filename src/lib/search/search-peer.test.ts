// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';

import type { CoreEvent, SearchPeerPause } from '#src/generated/protocol';
import { watchSearchPeers, type SearchPeerCore } from './search-peer';

class Channel extends EventTarget {
  label = 'sable-search-v1';
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = 'connecting';
  send = vi.fn<(data: Uint8Array) => void>();
  close = vi.fn(() => {
    this.readyState = 'closed';
  });
  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
  }
  deliver(...frames: number[][]): void {
    for (const frame of frames) {
      this.dispatchEvent(new MessageEvent('message', { data: new Uint8Array(frame).buffer }));
    }
  }
}

class Peer extends EventTarget {
  static instances: Peer[] = [];
  channel = new Channel();
  connectionState = 'new';
  iceGatheringState = 'complete';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  addIceCandidate = vi.fn(() => Promise.resolve());
  createDataChannel = vi.fn(() => {
    queueMicrotask(() => this.dispatchEvent(new Event('negotiationneeded')));
    return this.channel;
  });
  setLocalDescription = vi.fn(() => {
    this.localDescription = {
      type: this.remoteDescription?.type === 'offer' ? 'answer' : 'offer',
      sdp: 'local-sdp',
    };
    return Promise.resolve();
  });
  setRemoteDescription = vi.fn((description: { type: string; sdp: string }) => {
    this.remoteDescription = description;
    return Promise.resolve();
  });
  close = vi.fn();
  constructor() {
    super();
    Peer.instances.push(this);
  }
}

let listener: (event: CoreEvent) => void;
let subscribeEvents: Mock<SearchPeerCore['subscribeEvents']>;
let rtcData: Mock<SearchPeerCore['rtcData']>;
let core: SearchPeerCore;
let stop: (() => void) | undefined;

beforeEach(() => {
  Peer.instances = [];
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('navigator', {});
  subscribeEvents = vi.fn<SearchPeerCore['subscribeEvents']>((callback) => {
    listener = callback;
    return vi.fn();
  });
  rtcData = vi.fn<SearchPeerCore['rtcData']>(() => Promise.resolve(new Uint8Array(0)));
  core = {
    session: { account_id: 'account' },
    subscribeEvents,
    rtcData,
    rpc: {
      search: {
        peerStart: vi.fn(() => Promise.resolve(null)),
      },
      rtc: {
        signal: vi.fn(() => Promise.resolve(null)),
        close: vi.fn(() => Promise.resolve(null)),
      },
      calls: { turnServer: vi.fn(() => Promise.reject(new Error('no turn'))) },
    },
  };
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function start(): Channel {
  stop = watchSearchPeers(core, { stunServers: [] });
  listener({
    type: 'rtc',
    purpose: 'search_sharing',
    session_id: 'test',
    sender: true,
    signal: { kind: 'open' },
  });
  return Peer.instances[0].channel;
}

function receive(): Channel {
  stop = watchSearchPeers(core, { stunServers: [] });
  listener({
    type: 'rtc',
    purpose: 'search_sharing',
    session_id: 'test',
    sender: false,
    signal: { kind: 'negotiate', description: { type: 'offer', sdp: 'remote-sdp' } },
  });
  const peer = Peer.instances[0];
  peer.dispatchEvent(Object.assign(new Event('datachannel'), { channel: peer.channel }));
  return peer.channel;
}

test('unsupported browsers do not start discovery', () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  stop = watchSearchPeers(core, { stunServers: [] });
  expect(core.rpc.search.peerStart).not.toHaveBeenCalled();
  expect(subscribeEvents).not.toHaveBeenCalled();
});

test('foreground options finish applying before discovery starts', async () => {
  const ready = Promise.withResolvers<null>();
  stop = watchSearchPeers(core, {
    stunServers: [],
    beforeStart: () => ready.promise,
  });
  expect(subscribeEvents).not.toHaveBeenCalled();
  expect(core.rpc.search.peerStart).not.toHaveBeenCalled();
  ready.resolve(null);
  await vi.waitFor(() => {
    expect(core.rpc.search.peerStart).toHaveBeenCalledOnce();
  });
});

test('an account switch cancels startup while foreground options are pending', async () => {
  const ready = Promise.withResolvers<null>();
  stop = watchSearchPeers(core, {
    stunServers: [],
    beforeStart: () => ready.promise,
  });
  core.session = { account_id: 'other' };
  ready.resolve(null);
  await ready.promise;
  expect(subscribeEvents).not.toHaveBeenCalled();
  expect(core.rpc.search.peerStart).not.toHaveBeenCalled();
});

test('a visibility change during startup closes the connection', () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  const unsubscribe = vi.fn();
  subscribeEvents.mockImplementation(() => {
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    return unsubscribe;
  });
  stop = watchSearchPeers(core, { stunServers: [] });
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerStart).not.toHaveBeenCalled();
  visibility.mockRestore();
});

test('a failed foreground update can retry on the next activation', async () => {
  const ready = Promise.withResolvers<null>();
  const beforeStart = vi.fn(() => ready.promise);
  stop = watchSearchPeers(core, { stunServers: [], beforeStart });
  ready.reject(new Error('options unavailable'));
  await ready.promise.catch(() => {});
  await Promise.resolve();
  beforeStart.mockResolvedValue(null);
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => {
    expect(core.rpc.search.peerStart).toHaveBeenCalledOnce();
  });
});

test('a datachannel setup failure releases the peer immediately', () => {
  vi.stubGlobal(
    'RTCPeerConnection',
    class extends Peer {
      constructor() {
        super();
        this.createDataChannel.mockImplementation(() => {
          throw new Error('unsupported datachannel');
        });
      }
    }
  );
  stop = watchSearchPeers(core, { stunServers: [] });
  listener({
    type: 'rtc',
    purpose: 'search_sharing',
    session_id: 'test',
    sender: true,
    signal: { kind: 'open' },
  });
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
  expect(core.rpc.rtc.close).toHaveBeenCalledOnce();
});

test('deferred signaling rejection after cleanup does not reopen or double-close a session', async () => {
  const signal = Promise.withResolvers<null>();
  vi.mocked(core.rpc.rtc.signal).mockReturnValue(signal.promise);
  const channel = start();
  await vi.waitFor(() => {
    expect(core.rpc.rtc.signal).toHaveBeenCalledOnce();
  });
  stop?.();
  signal.reject(new Error('stopped'));
  await signal.promise.catch(() => {});
  expect(channel.close).toHaveBeenCalledOnce();
  expect(core.rpc.rtc.close).toHaveBeenCalledOnce();
});

test('a deferred exchange rejection after an account switch cannot call the new account', async () => {
  const exchange = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  rtcData.mockReturnValue(exchange.promise);
  const channel = receive();
  channel.open();
  await vi.waitFor(() => {
    expect(rtcData).toHaveBeenCalledOnce();
  });
  core.session = { account_id: 'other' };
  stop?.();
  exchange.reject(new Error('stopped'));
  await exchange.promise.catch(() => {});
  expect(channel.close).toHaveBeenCalledOnce();
  expect(core.rpc.rtc.close).not.toHaveBeenCalled();
});

test('rtc sessions of other features are left alone', () => {
  stop = watchSearchPeers(core, { stunServers: [] });
  listener({
    type: 'rtc',
    purpose: 'file_transfer' as 'search_sharing',
    session_id: 'other',
    sender: true,
    signal: { kind: 'open' },
  });
  expect(Peer.instances).toHaveLength(0);
  expect(core.rpc.rtc.close).not.toHaveBeenCalled();
});

test.each([
  ['sending', start],
  ['receiving', receive],
])('the %s device tells the core when its channel opens', async (_, open) => {
  const channel = open();
  channel.open();
  await vi.waitFor(() => {
    expect(rtcData).toHaveBeenCalledWith('test', new Uint8Array(0));
  });
  expect(channel.send).not.toHaveBeenCalled();
});

test('a negotiation timeout releases the connection', async () => {
  vi.useFakeTimers();
  start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
  expect(core.rpc.rtc.close).toHaveBeenCalledWith({ session_id: 'test' });
});

test('the core is started on resume and at regular intervals', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  stop = watchSearchPeers(core, { stunServers: [] });
  await vi.advanceTimersByTimeAsync(1000);
  visibility.mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  visibility.mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(core.rpc.search.peerStart).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(core.rpc.search.peerStart).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(core.rpc.search.peerStart).toHaveBeenCalledTimes(4);
  visibility.mockRestore();
});

test('idle channels close after two minutes', async () => {
  vi.useFakeTimers();
  const channel = start();
  channel.open();
  await vi.advanceTimersByTimeAsync(119_000);
  expect(channel.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(channel.close).toHaveBeenCalledOnce();
});

function pauseSharing(pause: SearchPeerPause | null): void {
  listener({
    type: 'search_sharing',
    sharing: {
      state: 'idle',
      pause,
      outcome: null,
      peer: null,
      rooms_copied: 0,
      last_copy: null,
      automatic: false,
      asked: 0,
      candidates: [],
    },
  });
}

test('a core pause closes the transfer and its end restarts discovery', async () => {
  start();
  expect(core.rpc.search.peerStart).toHaveBeenCalledOnce();
  pauseSharing('metered');
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
  expect(core.rpc.rtc.close).toHaveBeenCalledOnce();
  listener({
    type: 'rtc',
    purpose: 'search_sharing',
    session_id: 'second',
    sender: true,
    signal: { kind: 'open' },
  });
  expect(Peer.instances).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve));
  pauseSharing(null);
  expect(core.rpc.search.peerStart).toHaveBeenCalledTimes(2);
});

test('late account cleanup does not send old session RPCs to the new account', () => {
  start();
  core.session = { account_id: 'other' };
  stop?.();
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
  expect(core.rpc.rtc.close).not.toHaveBeenCalled();
});

test('a backend cancellation closes the browser channel', () => {
  const channel = start();
  listener({
    type: 'rtc',
    purpose: 'search_sharing',
    session_id: 'test',
    sender: false,
    signal: { kind: 'close' },
  });
  expect(channel.close).toHaveBeenCalledOnce();
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
});

test.each([
  ['text', 'end'],
  ['empty', new ArrayBuffer(0)],
])('%s frames close before reaching the core', (_, data) => {
  const channel = start();
  channel.dispatchEvent(new MessageEvent('message', { data }));
  expect(channel.close).toHaveBeenCalledOnce();
  expect(rtcData).not.toHaveBeenCalled();
});

test('frames reach the core one at a time and in order', async () => {
  const opening = Promise.withResolvers<Uint8Array<ArrayBuffer>>();
  rtcData.mockReturnValueOnce(opening.promise);
  const channel = receive();
  channel.open();
  channel.deliver([1], [2, 3]);
  await vi.waitFor(() => {
    expect(rtcData).toHaveBeenCalledOnce();
  });
  await Promise.resolve();
  expect(rtcData).toHaveBeenCalledOnce();
  opening.resolve(new Uint8Array(0));
  await vi.waitFor(() => {
    expect(rtcData).toHaveBeenCalledTimes(3);
  });
  expect(rtcData.mock.calls.map(([, frame]) => [...frame])).toEqual([[], [1], [2, 3]]);
  expect(channel.close).not.toHaveBeenCalled();
});

test('replies are sent in chunks of at most 16 KiB', async () => {
  const reply = new Uint8Array(40 * 1024).map((_, index) => index % 251);
  rtcData.mockResolvedValueOnce(reply);
  const channel = receive();
  channel.open();
  await vi.waitFor(() => {
    expect(channel.send).toHaveBeenCalledTimes(3);
  });
  const chunks = channel.send.mock.calls.map(([frame]) => frame);
  expect(chunks.map((chunk) => chunk.byteLength)).toEqual([16 * 1024, 16 * 1024, 8 * 1024]);
  expect(new Uint8Array(chunks.flatMap((chunk) => [...chunk]))).toEqual(reply);
});

test('a core error closes the channel', async () => {
  rtcData.mockRejectedValueOnce(new Error('malformed'));
  const channel = receive();
  channel.open();
  await vi.waitFor(() => {
    expect(channel.close).toHaveBeenCalledOnce();
  });
});
