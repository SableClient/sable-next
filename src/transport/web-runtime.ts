import type { Batch } from '#src/generated/protocol';
import { releaseProxy, wrap, type Remote } from 'comlink';

import type { AppMessage, AppRemote, AppRequest } from '#src/worker/app-protocol';
import { connect } from '../lib/runtime/client';
import { WireMismatchError } from '../lib/runtime/handshake';
import type { Link } from '../lib/runtime/link';
import { openSharedWorker } from './web';

const RELOAD_KEY = 'sable-runtime-reloaded';
/** Restarts in a row that fail to reach a handshake before the link gives up. */
const MAX_RESTARTS = 3;

export interface RuntimeConnection {
  handOver(port: MessagePort): void;
  onFailure(handler: (message: string) => void): void;
  retire(): void;
}

function openRuntimeWorker(): RuntimeConnection {
  const connection = openSharedWorker(false);
  return {
    handOver(port) {
      connection.port.postMessage({ runtime: true }, [port]);
      connection.port.postMessage({ disconnect: true });
    },
    onFailure: (handler) => {
      connection.onFailure(handler);
    },
    retire: () => {
      connection.retire();
    },
  };
}

/** The runtime gets a port of its own, so its traffic never mixes with the core's. */
export function createWebLink(open: () => RuntimeConnection = openRuntimeWorker): Link {
  const tab = crypto.randomUUID();
  const batchListeners = new Set<(batch: Batch) => void>();
  const restartListeners = new Set<() => void>();
  let current: { remote: Remote<AppRemote>; lost: Promise<never> };
  let restarts = 0;
  let broken: Error | null = null;

  function attach(): void {
    const connection = open();
    const channel = new MessageChannel();
    const port = channel.port1;
    const remote = wrap<AppRemote>(port);
    const loss = Promise.withResolvers<never>();
    void loss.promise.catch(() => undefined);
    current = { remote, lost: loss.promise };
    let ended = false;
    const end = (reason: Error) => {
      ended = true;
      loss.reject(reason);
      remote[releaseProxy]();
      port.onmessage = null;
      port.close();
      connection.retire();
    };
    const restart = () => {
      if (ended) return;
      if (++restarts > MAX_RESTARTS) {
        broken = new Error('the worker keeps crashing');
        end(broken);
        return;
      }
      end(new Error('the worker restarted'));
      attach();
      for (const listener of restartListeners) listener();
    };
    connection.onFailure(restart);
    port.onmessage = ({ data }: MessageEvent<AppMessage>) => {
      if (ended) return;
      if ('batch' in data) {
        for (const listener of batchListeners) listener(data.batch);
      } else if ('crashed' in data) {
        restart();
      } else if ('superseded' in data) {
        broken = new Error('a newer tab took over the worker');
        end(broken);
      }
    };
    connection.handOver(channel.port2);
    port.postMessage({ op: 'hello', tab } satisfies AppRequest);
  }

  async function ask<T>(call: (remote: Remote<AppRemote>) => Promise<T>): Promise<T> {
    await ready;
    if (broken) throw broken;
    const { remote, lost } = current;
    return Promise.race([call(remote), lost]);
  }

  // The worker must not watch for the lock's release before this tab owns it.
  const ready = new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request(`sable-runtime-tab-${tab}`, () => {
        attach();
        resolve();
        return new Promise<never>(() => {});
      })
      .catch(reject);
  });

  return {
    handshake: async () => {
      const handshake = await ask((remote) => remote.handshake());
      restarts = 0;
      return handshake;
    },
    subscribe: (request) => ask((remote) => remote.subscribe(request)),
    unsubscribe: (sub) => ask((remote) => remote.unsubscribe(sub)),
    resync: (sub) => ask((remote) => remote.resync(sub)),
    range: (sub, window) => ask((remote) => remote.range(sub, window)),
    dispatch: (target, action) => ask((remote) => remote.dispatch(target, action)),
    request: (target, action) => ask((remote) => remote.request(target, action)),
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

export async function startLink(open: () => Link): Promise<void> {
  try {
    await connect(open(), { onError: reloadOnce });
    sessionStorage.removeItem(RELOAD_KEY);
  } catch (error) {
    reloadOnce(error);
  }
}
