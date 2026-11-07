import type { CoreEvent, Rpc } from '#src/generated/protocol';
import { SearchPeerDecoder, encodeSearchPeerFrame } from '#lib/model/model.js';
import {
  connectRtc,
  iceServers,
  isRtcEvent,
  type RtcCore,
  type RtcEvent,
} from '#lib/rtc/connect.js';
import { reportSearchPeerConnection, selectedRoute } from '#lib/search/search-peer-diagnostics.js';

// The message and segment formats are described in docs/search-sharing.md.
const CHANNEL = 'sable-search-v1';
const MAX_MESSAGE_BYTES = 6 * 1024 * 1024;
const FRAME_BYTES = 16 * 1024;
const MAX_QUEUED_BYTES = 2 * MAX_MESSAGE_BYTES;
const MAX_QUEUED_MESSAGES = 8;
const MAX_SESSIONS = 4;
const BUFFER_HIGH = 64 * 1024;
const BUFFER_LOW = 32 * 1024;
const NEGOTIATION_MS = 20_000;
const IDLE_MS = 60_000;
const DISCOVERY_MS = 60_000;

export interface SearchPeerCore {
  session: { account_id: string } | null;
  rpc: RtcCore['rpc'] & {
    search: Pick<Rpc['search'], 'peerStart' | 'peerExchange'>;
    calls: Pick<Rpc['calls'], 'turnServer'>;
  };
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

function waitFor(
  target: EventTarget,
  event: string,
  ready: () => boolean,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      target.removeEventListener(event, check);
      signal.removeEventListener('abort', abort);
    };
    const check = (): void => {
      if (!ready()) return;
      cleanup();
      resolve();
    };
    const abort = (): void => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    target.addEventListener(event, check);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else check();
  });
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
  const sessions = new Map<
    string,
    { receive(event: RtcEvent): Promise<void>; close: () => void }
  >();
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

  function create(sessionId: string, initiator: boolean) {
    const decoder = new SearchPeerDecoder();
    const rtc = connectRtc(core, { sessionId, sender: initiator, iceServers: servers }, close);
    const { peer } = rtc;
    const abort = new AbortController();
    let channel: RTCDataChannel | null = null;
    let closed = false;
    let started = false;
    let hello: ReturnType<typeof setInterval> | undefined;
    let idle: ReturnType<typeof setTimeout>;
    let frameBytes = 0;
    let incomingBytes = 0;
    let incomingMessages = 0;
    let processing = Promise.resolve();
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
    const channelOpen = (): boolean => channel?.readyState === 'open' && active();

    function touch(): void {
      clearTimeout(idle);
      idle = setTimeout(close, IDLE_MS);
    }

    function close(): void {
      if (closed) return;
      closed = true;
      clearTimeout(negotiation);
      clearInterval(hello);
      clearTimeout(idle);
      abort.abort();
      decoder.free();
      channel?.close();
      sessions.delete(sessionId);
      if (current()) rtc.close();
      else peer.close();
    }

    async function sendFrame(frame: string | ArrayBuffer): Promise<void> {
      if (!channel || !channelOpen()) throw new Error('closed');
      if (channel.bufferedAmount > BUFFER_HIGH) {
        const target = channel;
        await waitFor(
          target,
          'bufferedamountlow',
          () => target.bufferedAmount <= BUFFER_LOW,
          abort.signal
        );
      }
      if (!channelOpen()) throw new Error('closed');
      if (typeof frame === 'string') channel.send(frame);
      else channel.send(frame);
      touch();
    }

    async function send(data: string): Promise<void> {
      const bytes = encodeSearchPeerFrame(data);
      for (let start = 0; start < bytes.length; start += FRAME_BYTES) {
        await sendFrame(new Uint8Array(bytes.subarray(start, start + FRAME_BYTES)).buffer);
      }
    }

    function exchange(data: string | null, bytes = 0): void {
      processing = processing
        .then(async () => {
          try {
            if (!active()) return;
            const reply = await rpc.peerExchange({ session_id: sessionId, data });
            if (reply !== null && active()) await send(reply);
          } finally {
            incomingBytes -= bytes;
            incomingMessages -= 1;
          }
        })
        .catch(close);
    }

    function receive(event: MessageEvent<unknown>): void {
      try {
        const frame = event.data;
        if (!allowed()) throw new Error('invalid frame');
        touch();
        if (frame === 'ready') {
          void sendFrame('ack').catch(close);
          return;
        }
        if (frame === 'ack') {
          if (!started) {
            started = true;
            clearInterval(hello);
            clearTimeout(negotiation);
            if (!initiator) {
              incomingMessages += 1;
              exchange(null);
            }
          }
          return;
        }
        if (
          !(frame instanceof ArrayBuffer) ||
          frame.byteLength === 0 ||
          frame.byteLength > FRAME_BYTES
        )
          throw new Error('invalid frame');
        if (frameBytes === 0 && incomingMessages >= MAX_QUEUED_MESSAGES)
          throw new Error('receive queue full');
        incomingBytes += frame.byteLength;
        frameBytes += frame.byteLength;
        if (incomingBytes > MAX_QUEUED_BYTES) throw new Error('receive queue full');
        const message = decoder.push(new Uint8Array(frame));
        if (message !== undefined) {
          incomingMessages += 1;
          const bytes = frameBytes;
          frameBytes = 0;
          exchange(message, bytes);
        }
      } catch {
        close();
      }
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
      target.bufferedAmountLowThreshold = BUFFER_LOW;
      target.addEventListener('close', close);
      target.addEventListener('error', close);
      target.addEventListener('message', receive);
      target.addEventListener(
        'open',
        () => {
          touch();
          if (started) return;
          const greet = (): void => {
            void sendFrame('ready').catch(close);
          };
          hello = setInterval(greet, 250);
          greet();
        },
        { once: true }
      );
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
    let session = sessions.get(event.session_id);
    if (!allowed() || event.signal.kind === 'close') {
      session?.close();
      return;
    }
    if (!session) {
      const opens = event.sender === (event.signal.kind === 'open');
      if (!opens || sessions.size >= MAX_SESSIONS) {
        void core.rpc.rtc.close({ session_id: event.session_id }).catch(() => {});
        return;
      }
      try {
        session = create(event.session_id, event.sender);
        sessions.set(event.session_id, session);
      } catch {
        return;
      }
    }
    void session.receive(event).catch(session.close);
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
    if (!allowed()) {
      for (const session of sessions.values()) session.close();
    } else discover();
  };
  const timer = setInterval(discover, DISCOVERY_MS);
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
    for (const session of sessions.values()) session.close();
    stopped = true;
  };
}
