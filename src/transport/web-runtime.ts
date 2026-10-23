import type { Batch } from '#src/generated/protocol';
import type { AppMessage, AppRequest } from '#src/worker/app-protocol';
import { connect } from '../lib/runtime/client';
import { WireMismatchError } from '../lib/runtime/handshake';
import type { Link } from '../lib/runtime/link';
import { openSharedWorker, type CoreConnection } from './web';

const RELOAD_KEY = 'sable-runtime-reloaded';
/** Restarts in a row that fail to reach a handshake before the link gives up. */
const MAX_RESTARTS = 3;

type Waiting = { resolve: (value: never) => void; reject: (error: Error) => void };

/**
 * A `Link` to the one worker that owns the app. The worker takes a port of its
 * own for this tab, so the runtime's traffic never mixes with the core's.
 * When the worker panics, the link opens the next worker and tells the client.
 */
export function createWebLink(open: () => CoreConnection = () => openSharedWorker(false)): Link {
  const tab = crypto.randomUUID();
  const batchListeners = new Set<(batch: Batch) => void>();
  const restartListeners = new Set<() => void>();
  const pending = new Map<number, Waiting>();
  let nextId = 1;
  let port: MessagePort;
  let restarts = 0;
  let broken: Error | null = null;

  // The worker holds a request on this lock and gets it once the tab is gone.
  void navigator.locks.request(`sable-runtime-tab-${tab}`, () => new Promise<never>(() => {}));

  function rejectPending(reason: Error): void {
    const waiting = [...pending.values()];
    pending.clear();
    for (const { reject } of waiting) reject(reason);
  }

  function attach(): void {
    const connection = open();
    const channel = new MessageChannel();
    connection.port.postMessage({ runtime: true }, [channel.port2]);
    connection.port.postMessage({ disconnect: true });
    port = channel.port1;
    port.onmessage = ({ data }: MessageEvent<AppMessage>) => {
      if ('batch' in data) {
        for (const listener of batchListeners) listener(data.batch);
      } else if ('crashed' in data) {
        connection.retire();
        port.close();
        if (++restarts > MAX_RESTARTS) {
          broken = new Error('the worker keeps crashing');
          rejectPending(broken);
          return;
        }
        attach();
        rejectPending(new Error('the worker restarted'));
        for (const listener of restartListeners) listener();
      } else if ('superseded' in data) {
        broken = new Error('a newer tab took over the worker');
        rejectPending(broken);
      } else {
        const waiting = pending.get(data.id);
        pending.delete(data.id);
        if ('ok' in data) waiting?.resolve(data.ok as never);
        else waiting?.reject(new Error(data.error));
      }
    };
    port.postMessage({ op: 'hello', tab } satisfies AppRequest);
  }

  function ask<T>(request: (id: number) => AppRequest): Promise<T> {
    if (broken) return Promise.reject(broken);
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      port.postMessage(request(id));
    });
  }

  attach();

  return {
    handshake: async () => {
      const handshake = await ask<Awaited<ReturnType<Link['handshake']>>>((id) => ({
        id,
        op: 'handshake',
      }));
      restarts = 0;
      return handshake;
    },
    subscribe: (request) => ask((id) => ({ id, op: 'subscribe', request })),
    unsubscribe: (sub) => ask((id) => ({ id, op: 'unsubscribe', sub })),
    resync: (sub) => ask((id) => ({ id, op: 'resync', sub })),
    range: (sub, window) => ask((id) => ({ id, op: 'range', sub, window })),
    dispatch: (target, action) => ask((id) => ({ id, op: 'dispatch', target, action })),
    request: (target, action) => ask((id) => ({ id, op: 'request', target, action })),
    onBatch: (listener) => {
      batchListeners.add(listener);
      return () => batchListeners.delete(listener);
    },
    onRestart: (listener) => {
      restartListeners.add(listener);
      return () => restartListeners.delete(listener);
    },
  };
}

/** A tab and a worker built from different sources cannot talk, and a reload brings the page up to date. */
function reloadOnce(error: unknown): void {
  if (!(error instanceof WireMismatchError)) {
    console.error('[sable runtime]', error);
    return;
  }
  if (sessionStorage.getItem(RELOAD_KEY)) {
    console.error('[sable runtime] still not matching after a reload', error.mismatch);
    return;
  }
  sessionStorage.setItem(RELOAD_KEY, '1');
  location.reload();
}

export async function startWebRuntime(link: Link = createWebLink()): Promise<void> {
  try {
    await connect(link, { onError: reloadOnce });
    sessionStorage.removeItem(RELOAD_KEY);
  } catch (error) {
    reloadOnce(error);
  }
}
