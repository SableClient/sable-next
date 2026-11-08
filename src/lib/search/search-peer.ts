import type { CoreEvent, Rpc } from '#src/generated/protocol';
import {
  connectRtc,
  iceServers,
  isRtcEvent,
  type RtcCore,
  type RtcEvent,
} from '#lib/rtc/connect.js';
import { reportSearchPeerConnection, selectedRoute } from '#lib/search/search-peer-diagnostics.js';

// Messages and their framing are described in docs/search-sharing.md.
const CHANNEL = 'sable-search-v1';
const CHUNK_BYTES = 16 * 1024;
const NEGOTIATION_MS = 20_000;
const IDLE_MS = 120_000;
const START_INTERVAL_MS = 60_000;

export interface SearchPeerCore {
  session: { account_id: string } | null;
  rpc: RtcCore['rpc'] & {
    search: Pick<Rpc['search'], 'peerStart'>;
    calls: Pick<Rpc['calls'], 'turnServer'>;
  };
  rtcData(sessionId: string, frame: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>>;
  subscribeEvents(callback: (event: CoreEvent) => void): () => void;
}

interface NetworkConnection extends EventTarget {
  type?: string;
  metered?: boolean;
  saveData?: boolean;
}

interface SearchPeerOptions {
  unmeteredOnly: boolean;
  stunServers: string[];
  beforeStart?: () => Promise<unknown>;
}

export function watchSearchPeers(core: SearchPeerCore, options: SearchPeerOptions): () => void {
  if (typeof RTCPeerConnection === 'undefined') return () => {};
  const account = core.session?.account_id;
  if (!account) return () => {};
  let attempt: AbortController | undefined;
  let stopped = false;
  const relinquish = (): void => {
    attempt?.abort();
    attempt = undefined;
  };
  const activate = (): void => {
    if (stopped || document.visibilityState !== 'visible' || core.session?.account_id !== account) {
      relinquish();
      return;
    }
    if (attempt) return;
    const pending = new AbortController();
    attempt = pending;
    const start = async (): Promise<void> => {
      if (options.beforeStart) await options.beforeStart();
      if (
        pending.signal.aborted ||
        stopped ||
        document.visibilityState !== 'visible' ||
        core.session?.account_id !== account
      )
        return;
      const stop = connectSearchPeers(core, options, account);
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          stop();
          resolve();
        };
        if (pending.signal.aborted) finish();
        else pending.signal.addEventListener('abort', finish, { once: true });
      });
    };
    const finished = (): void => {
      if (attempt === pending) attempt = undefined;
    };
    const locks = (navigator as { locks?: LockManager }).locks;
    const running = locks
      ? locks.request(`sable-search-peer:${account}`, { signal: pending.signal }, start)
      : start();
    void running.catch(() => {}).finally(finished);
  };
  document.addEventListener('visibilitychange', activate);
  activate();
  return () => {
    if (stopped) return;
    stopped = true;
    document.removeEventListener('visibilitychange', activate);
    relinquish();
  };
}

function connectSearchPeers(
  core: SearchPeerCore,
  options: SearchPeerOptions,
  account: string
): () => void {
  // The core runs one copy at a time, as sender or receiver.
  let session: { id: string; receive(event: RtcEvent): Promise<void>; close: () => void } | null =
    null;
  const connection = (navigator as Navigator & { connection?: NetworkConnection }).connection;
  const rpc = core.rpc.search;
  let stopped = false;
  let discovering = false;
  let servers: RTCIceServer[] = options.stunServers.map((urls) => ({ urls }));

  const current = (): boolean => !stopped && core.session?.account_id === account;
  const allowed = (): boolean =>
    current() &&
    navigator.onLine &&
    (!options.unmeteredOnly ||
      (connection?.type !== 'cellular' &&
        connection?.metered !== true &&
        connection?.saveData !== true));

  // The sender creates the channel. Framing and turn-taking live in the core.
  function create(sessionId: string, initiator: boolean) {
    const rtc = connectRtc(core, { sessionId, sender: initiator, iceServers: servers }, close);
    const { peer } = rtc;
    let channel: RTCDataChannel | null = null;
    let closed = false;
    let pending = Promise.resolve();
    let idle: ReturnType<typeof setTimeout> | undefined;
    const negotiation = setTimeout(close, NEGOTIATION_MS);
    const active = (): boolean => !closed && allowed();
    const report = (route: RTCIceCandidateType | null = null): void => {
      reportSearchPeerConnection({
        sessionId,
        sending: initiator,
        state: peer.connectionState,
        route,
      });
    };
    report();
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'connected')
        void selectedRoute(peer).then(report, () => {
          report();
        });
      else report();
    });

    function touch(): void {
      clearTimeout(idle);
      idle = setTimeout(close, IDLE_MS);
    }

    function close(): void {
      if (closed) return;
      closed = true;
      clearTimeout(negotiation);
      clearTimeout(idle);
      channel?.close();
      if (session?.id === sessionId) session = null;
      if (current()) rtc.close();
      else peer.close();
    }

    function send(bytes: Uint8Array<ArrayBuffer>): void {
      if (!channel || channel.readyState !== 'open' || !active()) throw new Error('closed');
      for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
        channel.send(bytes.slice(start, start + CHUNK_BYTES));
      }
      touch();
    }

    // Frames reach the core one at a time and in order.
    function forward(frame: Uint8Array<ArrayBuffer>): void {
      pending = pending
        .then(async () => {
          if (!active()) return;
          const reply = await core.rtcData(sessionId, frame);
          if (reply.byteLength > 0 && active()) send(reply);
        })
        .catch(close);
    }

    function receive(event: MessageEvent<unknown>): void {
      const frame = event.data;
      // An empty frame tells the core the channel opened.
      if (!active() || !(frame instanceof ArrayBuffer) || frame.byteLength === 0) {
        close();
        return;
      }
      touch();
      forward(new Uint8Array(frame));
    }

    function opened(): void {
      clearTimeout(negotiation);
      touch();
      forward(new Uint8Array(0));
    }

    function attach(target: RTCDataChannel): void {
      if (
        channel ||
        target.label !== CHANNEL ||
        !target.ordered ||
        target.maxRetransmits !== null ||
        target.maxPacketLifeTime !== null
      ) {
        target.close();
        close();
        return;
      }
      channel = target;
      target.binaryType = 'arraybuffer';
      target.addEventListener('close', close);
      target.addEventListener('error', close);
      target.addEventListener('message', receive);
      if (target.readyState === 'open') opened();
      else target.addEventListener('open', opened, { once: true });
    }

    peer.addEventListener('datachannel', (event) => {
      attach(event.channel);
    });
    try {
      if (initiator) attach(peer.createDataChannel(CHANNEL, { ordered: true }));
    } catch (error) {
      close();
      throw error;
    }

    return {
      id: sessionId,
      close,
      receive(event: RtcEvent): Promise<void> {
        if (!active()) {
          close();
          return Promise.resolve();
        }
        return rtc.receive(event);
      },
    };
  }

  const unsubscribe = core.subscribeEvents((event) => {
    if (!isRtcEvent(event, 'search_sharing') || !current()) return;
    let target = session?.id === event.session_id ? session : null;
    if (!allowed() || event.signal.kind === 'close') {
      target?.close();
      return;
    }
    if (!target) {
      const opens = event.sender === (event.signal.kind === 'open');
      if (!opens || session) {
        void core.rpc.rtc.close({ session_id: event.session_id }).catch(() => {});
        return;
      }
      try {
        target = create(event.session_id, event.sender);
        session = target;
      } catch {
        return;
      }
    }
    void target.receive(event).catch(target.close);
  });

  const discover = (): void => {
    if (!allowed() || document.visibilityState !== 'visible' || discovering) return;
    discovering = true;
    void Promise.all([
      iceServers(options.stunServers, () => core.rpc.calls.turnServer()).then((next) => {
        servers = next;
      }),
      rpc.peerStart({}),
    ])
      .catch(() => {})
      .finally(() => {
        discovering = false;
      });
  };
  const networkChanged = (): void => {
    if (!allowed()) session?.close();
    else discover();
  };
  const timer = setInterval(discover, START_INTERVAL_MS);
  window.addEventListener('online', networkChanged);
  window.addEventListener('offline', networkChanged);
  connection?.addEventListener('change', networkChanged);
  discover();

  return () => {
    if (stopped) return;
    unsubscribe();
    clearInterval(timer);
    window.removeEventListener('online', networkChanged);
    window.removeEventListener('offline', networkChanged);
    connection?.removeEventListener('change', networkChanged);
    session?.close();
    stopped = true;
  };
}
