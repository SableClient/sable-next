// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi, type Mock } from 'vitest';

import { SearchPeerDecoder, encodeSearchPeerFrame } from '#lib/model/model.js';
import { watchSearchPeers, type SearchPeerCore, type SearchPeerEvent } from './search-peer';

class Channel extends EventTarget {
  label = 'sable-search-v1';
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  readyState = 'connecting';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  send = vi.fn<(data: string | ArrayBuffer) => void>();
  close = vi.fn(() => {
    this.readyState = 'closed';
  });
  open(): void {
    this.readyState = 'open';
    this.dispatchEvent(new Event('open'));
    this.dispatchEvent(new MessageEvent('message', { data: 'ack' }));
  }
}

function framed(message: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(message);
  const frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, bytes.length);
  frame.set(bytes, 4);
  return frame.buffer;
}

test('length-delimited frames decode across arbitrary byte boundaries', () => {
  const decoder = new SearchPeerDecoder();
  try {
    const bytes = encodeSearchPeerFrame('中文🙂');
    for (const byte of bytes.subarray(0, -1)) {
      expect(decoder.push(new Uint8Array([byte]))).toBeUndefined();
    }
    expect(decoder.push(bytes.subarray(-1))).toBe('中文🙂');
    expect(decoder.push(new Uint8Array([0, 0, 0, 0]))).toBe('');
  } finally {
    decoder.free();
  }
});

test('length-delimited frames reject oversized and malformed payloads', () => {
  for (const bytes of [
    new Uint8Array([0, 96, 0, 1]),
    new Uint8Array([0, 0, 0, 1, 255]),
    new Uint8Array([0, 0, 0, 0, 0]),
  ]) {
    const decoder = new SearchPeerDecoder();
    try {
      expect(() => decoder.push(bytes)).toThrow();
    } finally {
      decoder.free();
    }
  }
  expect(() => encodeSearchPeerFrame('x'.repeat(6 * 1024 * 1024 + 1))).toThrow();
});

test('a maximum-sized frame survives 16 KiB data-channel chunks', () => {
  const message = 'x'.repeat(6 * 1024 * 1024);
  const bytes = encodeSearchPeerFrame(message);
  const decoder = new SearchPeerDecoder();
  try {
    let decoded: string | undefined;
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      decoded = decoder.push(bytes.subarray(offset, offset + 16 * 1024));
    }
    expect(decoded).toBe(message);
  } finally {
    decoder.free();
  }
});

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

let listener: (event: SearchPeerEvent) => void;
let subscribeEvents: Mock<SearchPeerCore['subscribeEvents']>;
let core: SearchPeerCore;
let stop: (() => void) | undefined;
let connection: EventTarget & { type: string };

beforeEach(() => {
  Peer.instances = [];
  vi.stubGlobal('RTCPeerConnection', Peer);
  connection = Object.assign(new EventTarget(), { type: 'wifi' });
  vi.stubGlobal('navigator', { onLine: true, connection });
  subscribeEvents = vi.fn<SearchPeerCore['subscribeEvents']>((callback) => {
    listener = callback;
    return vi.fn();
  });
  core = {
    session: { account_id: 'account' },
    subscribeEvents,
    rpc: {
      search: {
        peerStart: vi.fn(() => Promise.resolve(null)),
        peerSignal: vi.fn(() => Promise.resolve(null)),
        peerExchange: vi.fn(() => Promise.resolve(null)),
        peerClose: vi.fn(() => Promise.resolve(null)),
      },
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
  stop = watchSearchPeers(core, { unmeteredOnly: true });
  listener({ type: 'search_peer', session_id: 'test', initiator: true, signal: { kind: 'open' } });
  return Peer.instances[0].channel;
}

test('unsupported browsers do not start discovery', () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  stop = watchSearchPeers(core, { unmeteredOnly: true });
  expect(core.rpc.search.peerStart).not.toHaveBeenCalled();
  expect(subscribeEvents).not.toHaveBeenCalled();
});

test('foreground options finish applying before discovery starts', async () => {
  const ready = Promise.withResolvers<null>();
  stop = watchSearchPeers(core, { unmeteredOnly: true, beforeStart: () => ready.promise });
  expect(subscribeEvents).not.toHaveBeenCalled();
  expect(core.rpc.search.peerStart).not.toHaveBeenCalled();
  ready.resolve(null);
  await vi.waitFor(() => {
    expect(core.rpc.search.peerStart).toHaveBeenCalledOnce();
  });
});

test('an account switch cancels startup while foreground options are pending', async () => {
  const ready = Promise.withResolvers<null>();
  stop = watchSearchPeers(core, { unmeteredOnly: true, beforeStart: () => ready.promise });
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
  stop = watchSearchPeers(core, { unmeteredOnly: true });
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerStart).not.toHaveBeenCalled();
  visibility.mockRestore();
});

test('a failed foreground update can retry on the next activation', async () => {
  const ready = Promise.withResolvers<null>();
  const beforeStart = vi.fn(() => ready.promise);
  stop = watchSearchPeers(core, { unmeteredOnly: true, beforeStart });
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
  stop = watchSearchPeers(core, { unmeteredOnly: true });
  listener({ type: 'search_peer', session_id: 'test', initiator: true, signal: { kind: 'open' } });
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerClose).toHaveBeenCalledOnce();
});

test('deferred signaling rejection after cleanup does not reopen or double-close a session', async () => {
  const signal = Promise.withResolvers<null>();
  vi.mocked(core.rpc.search.peerSignal).mockReturnValue(signal.promise);
  const channel = start();
  await vi.waitFor(() => {
    expect(core.rpc.search.peerSignal).toHaveBeenCalledOnce();
  });
  stop?.();
  signal.reject(new Error('stopped'));
  await signal.promise.catch(() => {});
  expect(channel.close).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerClose).toHaveBeenCalledOnce();
});

test('a deferred exchange rejection after an account switch cannot call the new account', async () => {
  const exchange = Promise.withResolvers<string | null>();
  vi.mocked(core.rpc.search.peerExchange).mockReturnValue(exchange.promise);
  const channel = start();
  channel.open();
  await vi.waitFor(() => {
    expect(core.rpc.search.peerExchange).toHaveBeenCalledOnce();
  });
  core.session = { account_id: 'other' };
  stop?.();
  exchange.reject(new Error('stopped'));
  await exchange.promise.catch(() => {});
  expect(channel.close).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerClose).not.toHaveBeenCalled();
});

test('index requests wait for acknowledgement and retry a lost greeting', async () => {
  vi.useFakeTimers();
  const channel = start();
  channel.readyState = 'open';
  channel.dispatchEvent(new Event('open'));
  await vi.advanceTimersByTimeAsync(250);
  expect(channel.send.mock.calls).toEqual([['ready'], ['ready']]);
  expect(core.rpc.search.peerExchange).not.toHaveBeenCalled();
  channel.dispatchEvent(new MessageEvent('message', { data: 'ready' }));
  await vi.advanceTimersByTimeAsync(0);
  expect(channel.send).toHaveBeenLastCalledWith('ack');
  expect(core.rpc.search.peerExchange).not.toHaveBeenCalled();
  channel.dispatchEvent(new MessageEvent('message', { data: 'ack' }));
  channel.dispatchEvent(new MessageEvent('message', { data: 'ack' }));
  await vi.advanceTimersByTimeAsync(1000);
  expect(core.rpc.search.peerExchange).toHaveBeenCalledOnce();
  expect(channel.send.mock.calls).toEqual([['ready'], ['ready'], ['ack']]);
});

test('a negotiation timeout releases the connection', async () => {
  vi.useFakeTimers();
  start();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerClose).toHaveBeenCalledWith({ session_id: 'test' });
});

test('discovery retries on resume and at regular intervals', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  stop = watchSearchPeers(core, { unmeteredOnly: true });
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

test('idle channels close after sixty seconds', async () => {
  vi.useFakeTimers();
  const channel = start();
  channel.open();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(channel.close).toHaveBeenCalledOnce();
});

test('metered and offline transitions close active transfers', () => {
  start();
  connection.type = 'cellular';
  connection.dispatchEvent(new Event('change'));
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerClose).toHaveBeenCalledOnce();
  connection.type = 'wifi';
  listener({
    type: 'search_peer',
    session_id: 'second',
    initiator: true,
    signal: { kind: 'open' },
  });
  vi.stubGlobal('navigator', { onLine: false, connection });
  window.dispatchEvent(new Event('offline'));
  expect(Peer.instances[1].close).toHaveBeenCalledOnce();
});

test('late account cleanup does not send old session RPCs to the new account', () => {
  start();
  core.session = { account_id: 'other' };
  stop?.();
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerClose).not.toHaveBeenCalled();
});

test('the sender offers on negotiationneeded and trickles candidates', async () => {
  start();
  const peer = Peer.instances[0];
  await vi.waitFor(() => {
    expect(core.rpc.search.peerSignal).toHaveBeenCalledWith({
      session_id: 'test',
      signal: { kind: 'negotiate', description: { type: 'offer', sdp: 'local-sdp' } },
    });
  });
  peer.dispatchEvent(
    Object.assign(new Event('icecandidate'), {
      candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
    })
  );
  await vi.waitFor(() => {
    expect(core.rpc.search.peerSignal).toHaveBeenLastCalledWith({
      session_id: 'test',
      signal: {
        kind: 'candidate',
        candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 },
      },
    });
  });
});

test('the receiver answers each offer and queues early candidates', async () => {
  stop = watchSearchPeers(core, { unmeteredOnly: true });
  const candidate = { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 };
  listener({
    type: 'search_peer',
    session_id: 'test',
    initiator: false,
    signal: { kind: 'candidate', candidate },
  });
  const peer = Peer.instances[0];
  expect(peer.addIceCandidate).not.toHaveBeenCalled();
  listener({
    type: 'search_peer',
    session_id: 'test',
    initiator: false,
    signal: { kind: 'negotiate', description: { type: 'offer', sdp: 'remote' } },
  });
  listener({
    type: 'search_peer',
    session_id: 'test',
    initiator: false,
    signal: { kind: 'candidate', candidate },
  });
  await vi.waitFor(() => {
    expect(peer.addIceCandidate).toHaveBeenCalledTimes(2);
    expect(core.rpc.search.peerSignal).toHaveBeenCalledWith({
      session_id: 'test',
      signal: { kind: 'negotiate', description: { type: 'answer', sdp: 'local-sdp' } },
    });
  });
  listener({
    type: 'search_peer',
    session_id: 'test',
    initiator: false,
    signal: { kind: 'negotiate', description: { type: 'offer', sdp: 'renegotiated' } },
  });
  await vi.waitFor(() => {
    expect(peer.setRemoteDescription).toHaveBeenLastCalledWith({
      type: 'offer',
      sdp: 'renegotiated',
    });
    expect(peer.setLocalDescription).toHaveBeenCalledTimes(2);
  });
});

test('a receiver closes on an answer that only the sender may send', async () => {
  stop = watchSearchPeers(core, { unmeteredOnly: true });
  listener({
    type: 'search_peer',
    session_id: 'test',
    initiator: false,
    signal: { kind: 'negotiate', description: { type: 'answer', sdp: 'remote' } },
  });
  await vi.waitFor(() => {
    expect(Peer.instances[0].close).toHaveBeenCalledOnce();
  });
});

test('a backend cancellation closes the browser channel', () => {
  const channel = start();
  listener({
    type: 'search_peer',
    session_id: 'test',
    initiator: false,
    signal: { kind: 'close' },
  });
  expect(channel.close).toHaveBeenCalledOnce();
  expect(Peer.instances[0].close).toHaveBeenCalledOnce();
});

test('invalid or oversized frames close before reaching the core', () => {
  const channel = start();
  channel.dispatchEvent(
    new MessageEvent('message', { data: new Uint8Array([0, 96, 0, 1]).buffer })
  );
  expect(channel.close).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerExchange).not.toHaveBeenCalled();
});

test('incoming messages reach the core in order without overlapping RPCs', async () => {
  const channel = start();
  const first = Promise.withResolvers<null>();
  vi.mocked(core.rpc.search.peerExchange).mockImplementation(({ data }) =>
    data === 'a' ? first.promise : Promise.resolve(null)
  );
  channel.open();
  await vi.waitFor(() => {
    expect(core.rpc.search.peerExchange).toHaveBeenCalledOnce();
  });
  for (const data of ['a', 'b']) {
    channel.dispatchEvent(new MessageEvent('message', { data: framed(data) }));
  }
  await vi.waitFor(() => {
    expect(core.rpc.search.peerExchange).toHaveBeenCalledTimes(2);
  });
  expect(vi.mocked(core.rpc.search.peerExchange).mock.calls[1][0].data).toBe('a');
  first.resolve(null);
  await vi.waitFor(() => {
    expect(core.rpc.search.peerExchange).toHaveBeenCalledTimes(3);
  });
  expect(vi.mocked(core.rpc.search.peerExchange).mock.calls[2][0].data).toBe('b');
});

test('too many queued messages close the channel while the core is busy', async () => {
  const channel = start();
  const pending = Promise.withResolvers<null>();
  vi.mocked(core.rpc.search.peerExchange).mockReturnValue(pending.promise);
  channel.open();
  await vi.waitFor(() => {
    expect(core.rpc.search.peerExchange).toHaveBeenCalledOnce();
  });
  for (let index = 0; index < 9; index += 1) {
    channel.dispatchEvent(new MessageEvent('message', { data: framed('') }));
  }
  expect(channel.close).toHaveBeenCalledOnce();
  expect(core.rpc.search.peerExchange).toHaveBeenCalledOnce();
  pending.resolve(null);
});

test('UTF-8 chunks fit the datachannel limit and wait for backpressure', async () => {
  const data = '中文🙂'.repeat(10_000);
  vi.mocked(core.rpc.search.peerExchange).mockResolvedValueOnce(data);
  const channel = start();
  channel.bufferedAmount = 80 * 1024;
  channel.open();
  await vi.waitFor(() => {
    expect(core.rpc.search.peerExchange).toHaveBeenCalledOnce();
  });
  expect(channel.send).not.toHaveBeenCalled();
  channel.bufferedAmount = 0;
  channel.dispatchEvent(new Event('bufferedamountlow'));
  await vi.waitFor(() => {
    expect(channel.send.mock.calls.length).toBeGreaterThan(5);
  });
  const frames = channel.send.mock.calls.map(([frame]) => frame);
  const chunks = frames.filter((frame): frame is ArrayBuffer => frame instanceof ArrayBuffer);
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    expect(chunk.byteLength).toBeLessThanOrEqual(16 * 1024);
    bytes.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  }
  expect(new DataView(bytes.buffer).getUint32(0)).toBe(bytes.length - 4);
  expect(new TextDecoder().decode(bytes.subarray(4))).toBe(data);
});
