import { expect, test, vi } from 'vitest';

import type { SearchPeerSignal } from '#src/generated/protocol';
import { watchSearchPeers, type SearchPeerCore, type SearchPeerEvent } from './search-peer';

test(
  'two devices exchange chunked history through real WebRTC channels',
  { timeout: 30_000 },
  async () => {
    const payload = 'History with 中文 and 🙂 '.repeat(20_000);
    const received: string[][] = [[], []];
    const listeners = [
      new Set<(event: SearchPeerEvent) => void>(),
      new Set<(event: SearchPeerEvent) => void>(),
    ];
    const signals: SearchPeerSignal[] = [];
    const send = vi.spyOn(RTCDataChannel.prototype, 'send');
    const cores = [0, 1].map((side): SearchPeerCore => ({
      session: { account_id: `account-${side}` },
      subscribeEvents(callback) {
        listeners[side].add(callback);
        return () => listeners[side].delete(callback);
      },
      rpc: {
        search: {
          peerStart: vi.fn(() => Promise.resolve(null)),
          peerSignal: vi.fn<SearchPeerCore['rpc']['search']['peerSignal']>(
            ({ session_id, signal }) => {
              signals.push(signal);
              queueMicrotask(() => {
                for (const listener of listeners[1 - side]) {
                  listener({ type: 'search_peer', session_id, initiator: side === 1, signal });
                }
              });

              return Promise.resolve(null);
            }
          ),
          peerExchange: vi.fn<SearchPeerCore['rpc']['search']['peerExchange']>(({ data }) => {
            if (data === null) return Promise.resolve(`request-${side}`);
            if (data === `request-${1 - side}`) return Promise.resolve(`${side}:${payload}`);
            received[side].push(data);
            return Promise.resolve(null);
          }),
          peerClose: vi.fn(() => Promise.resolve(null)),
        },
      },
    }));
    const stops = cores.map((core) =>
      watchSearchPeers(core, { unmeteredOnly: true, stunServers: [] })
    );
    try {
      await vi.waitFor(() => {
        expect(cores[0].rpc.search.peerStart).toHaveBeenCalledOnce();
        expect(cores[1].rpc.search.peerStart).toHaveBeenCalledOnce();
      });
      for (const listener of listeners[0]) {
        listener({
          type: 'search_peer',
          session_id: 'loopback',
          initiator: true,
          signal: { kind: 'open' },
        });
      }
      await vi.waitFor(
        () => {
          expect(received.map((messages) => messages.length)).toEqual([1, 1]);
        },
        { timeout: 20_000, interval: 50 }
      );
      expect(received[0]).toEqual([`1:${payload}`]);
      expect(received[1]).toEqual([`0:${payload}`]);
      expect(signals.filter(({ kind }) => kind === 'negotiate')).toHaveLength(2);
      const candidates = signals.flatMap((signal) =>
        signal.kind === 'candidate' ? [signal.candidate.candidate] : []
      );
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.every((line) => !line.includes('typ relay'))).toBe(true);
      expect(send.mock.calls.length).toBeGreaterThan(20);
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
    expect(cores[0].rpc.search.peerClose).toHaveBeenCalledWith({ session_id: 'loopback' });
    expect(cores[1].rpc.search.peerClose).toHaveBeenCalledWith({ session_id: 'loopback' });
  }
);

test('a hidden lock owner releases peer handling to a waiting visible tab', async () => {
  const core: SearchPeerCore = {
    session: { account_id: 'visibility-handoff' },
    subscribeEvents: vi.fn(() => () => {}),
    rpc: {
      search: {
        peerStart: vi.fn(() => Promise.resolve(null)),
        peerSignal: vi.fn(() => Promise.resolve(null)),
        peerExchange: vi.fn(() => Promise.resolve(null)),
        peerClose: vi.fn(() => Promise.resolve(null)),
      },
    },
  };
  const stop = watchSearchPeers(core, { unmeteredOnly: true, stunServers: [] });
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
    rpc: {
      search: {
        peerStart: vi.fn(() => Promise.resolve(null)),
        peerSignal: vi.fn(() => Promise.resolve(null)),
        peerExchange: vi.fn(() => Promise.resolve(null)),
        peerClose: vi.fn(() => Promise.resolve(null)),
      },
    },
  });
  const first = core();
  const second = core();
  const stopFirst = watchSearchPeers(first, { unmeteredOnly: true, stunServers: [] });
  const stopSecond = watchSearchPeers(second, { unmeteredOnly: true, stunServers: [] });
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
