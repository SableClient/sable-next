import { expect, test, vi } from 'vitest';

import type { RtcSignal } from '#src/generated/protocol';
import type { RtcEvent } from '#lib/rtc/connect.js';
import { watchSearchPeers, type SearchPeerCore } from './search-peer';

function framed(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const message = new Uint8Array(4 + body.length);
  new DataView(message.buffer).setUint32(0, body.length);
  message.set(body, 4);
  return message;
}

test(
  'the receiving device downloads chunked history through real WebRTC channels',
  { timeout: 30_000 },
  async () => {
    const payload = new Uint8Array(300_000).map((_, index) => index % 251);
    const inboxes: number[][] = [[], []];
    const received: Uint8Array[][] = [[], []];
    const listeners = [new Set<(event: RtcEvent) => void>(), new Set<(event: RtcEvent) => void>()];
    const signals: RtcSignal[] = [];
    const send = vi.spyOn(RTCDataChannel.prototype, 'send');
    const cores = [0, 1].map((side): SearchPeerCore => ({
      session: { account_id: `account-${side}` },
      subscribeEvents(callback) {
        listeners[side].add(callback);
        return () => listeners[side].delete(callback);
      },
      rtcData: vi.fn<SearchPeerCore['rtcData']>((_, frame) => {
        const nothing = new Uint8Array(0);
        if (frame.length === 0)
          return Promise.resolve(side === 1 ? framed(new Uint8Array([1])) : nothing);
        const inbox = inboxes[side];
        for (const byte of frame) inbox.push(byte);
        const length = new DataView(Uint8Array.from(inbox.slice(0, 4)).buffer).getUint32(0);
        if (inbox.length < 4 + length) return Promise.resolve(nothing);
        received[side].push(Uint8Array.from(inbox.splice(0).slice(4)));
        return Promise.resolve(side === 0 ? framed(payload) : nothing);
      }),
      rpc: {
        search: {
          peerStart: vi.fn(() => Promise.resolve(null)),
        },
        rtc: {
          signal: vi.fn<SearchPeerCore['rpc']['rtc']['signal']>(({ session_id, signal }) => {
            signals.push(signal);
            queueMicrotask(() => {
              for (const listener of listeners[1 - side]) {
                listener({
                  type: 'rtc',
                  purpose: 'search_sharing',
                  session_id,
                  sender: side === 1,
                  signal,
                });
              }
            });

            return Promise.resolve(null);
          }),
          close: vi.fn(() => Promise.resolve(null)),
        },
        calls: { turnServer: vi.fn(() => Promise.reject(new Error('no turn'))) },
      },
    }));
    const stops = cores.map((core) => watchSearchPeers(core, { stunServers: [] }));
    try {
      await vi.waitFor(() => {
        expect(cores[0].rpc.search.peerStart).toHaveBeenCalledOnce();
        expect(cores[1].rpc.search.peerStart).toHaveBeenCalledOnce();
      });
      for (const listener of listeners[0]) {
        listener({
          type: 'rtc',
          purpose: 'search_sharing',
          session_id: 'loopback',
          sender: true,
          signal: { kind: 'open' },
        });
      }
      await vi.waitFor(
        () => {
          expect(received.map((messages) => messages.length)).toEqual([1, 1]);
        },
        { timeout: 20_000, interval: 50 }
      );
      expect(received[0]).toEqual([new Uint8Array([1])]);
      expect(received[1]).toEqual([payload]);
      expect(signals.filter(({ kind }) => kind === 'negotiate')).toHaveLength(2);
      const candidates = signals.flatMap((signal) =>
        signal.kind === 'candidate' ? [signal.candidate.candidate] : []
      );
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((line) => !line.includes('typ relay'))).toBe(true);
      expect(send).toHaveBeenCalledTimes(1 + Math.ceil((payload.length + 4) / (16 * 1024)));
      const encoder = new TextEncoder();
      for (const [frame] of send.mock.calls) {
        const size = typeof frame === 'string' ? encoder.encode(frame).length : frame.byteLength;
        expect(size).toBeLessThanOrEqual(16 * 1024);
      }
    } finally {
      stops.forEach((stop) => {
        stop();
      });
      send.mockRestore();
    }
    expect(cores[0].rpc.rtc.close).toHaveBeenCalledWith({ session_id: 'loopback' });
    expect(cores[1].rpc.rtc.close).toHaveBeenCalledWith({ session_id: 'loopback' });
  }
);

test('a hidden lock owner releases peer handling to a waiting visible tab', async () => {
  const core: SearchPeerCore = {
    session: { account_id: 'visibility-handoff' },
    subscribeEvents: vi.fn(() => () => {}),
    rtcData: vi.fn(() => Promise.resolve(new Uint8Array(0))),
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
  const stop = watchSearchPeers(core, { stunServers: [] });
  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  const abort = new AbortController();
  let acquired = false;
  let release: (() => void) | undefined;
  let waiting: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => {
      expect(core.rpc.search.peerStart).toHaveBeenCalledOnce();
    });
    waiting = navigator.locks
      .request('sable-search-peer:visibility-handoff', { signal: abort.signal }, async () => {
        acquired = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })
      .catch(() => {});
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => {
      expect(acquired).toBe(true);
    });
  } finally {
    stop();
    abort.abort();
    release?.();
    await waiting;
    visibility.mockRestore();
  }
});

test('only one tab handles shared-worker peer sessions for an account', async () => {
  const core = (): SearchPeerCore => ({
    session: { account_id: 'shared-worker-account' },
    subscribeEvents: vi.fn(() => () => {}),
    rtcData: vi.fn(() => Promise.resolve(new Uint8Array(0))),
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
  });
  const first = core();
  const second = core();
  const stopFirst = watchSearchPeers(first, { stunServers: [] });
  const stopSecond = watchSearchPeers(second, { stunServers: [] });
  try {
    await vi.waitFor(() => {
      expect(first.rpc.search.peerStart).toHaveBeenCalledOnce();
    });
    expect(second.rpc.search.peerStart).not.toHaveBeenCalled();
    stopFirst();
    await vi.waitFor(() => {
      expect(second.rpc.search.peerStart).toHaveBeenCalledOnce();
    });
  } finally {
    stopFirst();
    stopSecond();
  }
});
