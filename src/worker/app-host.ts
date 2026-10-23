import { expose, finalizer } from 'comlink';

import type { Batch, Handshake, Snapshot, Subscribed } from '#src/generated/protocol';
import type { AppRemote, AppRequest } from './app-protocol';

export interface AppApi {
  handshake(): string;
  open(tab: number): Promise<void>;
  close(tab: number): Promise<void>;
  subscribe(tab: number, request: string): Promise<string>;
  unsubscribe(tab: number, sub: number): Promise<void>;
  resync(tab: number, sub: number): Promise<string>;
  range(tab: number, sub: number, window: string): Promise<string>;
  dispatch(target: string, action: string): Promise<void>;
  request(tab: number, target: string, action: string): Promise<bigint | number>;
}

export type TabPort = {
  postMessage(message: unknown): void;
  onmessage: ((message: MessageEvent<AppRequest>) => unknown) | null;
  start(): void;
  close?(): void;
};

interface Tab {
  port: TabPort;
  opened: Promise<void>;
  closed: boolean;
  watching: AbortController;
}

function tabGone(tab: string, signal: AbortSignal): Promise<void> {
  return navigator.locks
    .request(`sable-runtime-tab-${tab}`, { signal }, () => undefined)
    .then(() => undefined);
}

export function createAppHost(app: Promise<AppApi>, gone: typeof tabGone = tabGone) {
  const tabs = new Map<number, Tab>();
  let nextTab = 1;

  async function release(id: number, tab: Tab): Promise<void> {
    if (tab.closed) return;
    tab.closed = true;
    tab.watching.abort();
    tabs.delete(id);
    await tab.opened;
    await (await app).close(id);
    tab.port.close?.();
  }

  function attach(port: TabPort): void {
    const id = nextTab++;
    const tab: Tab = {
      port,
      opened: app.then((api) => api.open(id)),
      closed: false,
      watching: new AbortController(),
    };
    tabs.set(id, tab);
    async function serve<T>(call: (api: AppApi) => T | Promise<T>): Promise<T> {
      try {
        await tab.opened;
        return await call(await app);
      } catch (error) {
        throw new Error(
          typeof error === 'string' ? error : error instanceof Error ? error.message : 'invalid',
          { cause: error }
        );
      }
    }
    const json = JSON.stringify;
    expose(
      {
        handshake: () => serve((api) => JSON.parse(api.handshake()) as Handshake),
        subscribe: (request) =>
          serve(async (api) => JSON.parse(await api.subscribe(id, json(request))) as Subscribed),
        unsubscribe: (sub) => serve((api) => api.unsubscribe(id, sub)),
        resync: (sub) => serve(async (api) => JSON.parse(await api.resync(id, sub)) as Snapshot),
        range: (sub, window) =>
          serve(async (api) => JSON.parse(await api.range(id, sub, json(window))) as Snapshot),
        dispatch: (target, action) => serve((api) => api.dispatch(json(target), json(action))),
        request: (target, action) =>
          serve(async (api) => Number(await api.request(id, json(target), json(action)))),
        [finalizer]: () => {
          void release(id, tab);
        },
      } satisfies AppRemote & { [finalizer](): void },
      {
        postMessage: (message: unknown) => {
          port.postMessage(message);
        },
        addEventListener: (_, listener) => {
          port.onmessage = (event) => {
            const { data } = event;
            if (data.op === 'hello') {
              gone(data.tab, tab.watching.signal).then(
                () => release(id, tab),
                () => undefined
              );
            } else if (typeof listener === 'function') listener(event);
            else listener.handleEvent(event);
          };
        },
        removeEventListener: () => {
          port.onmessage = null;
        },
        start: () => {
          port.start();
        },
      }
    );
  }

  function deliver(tab: number, batch: string): void {
    tabs.get(tab)?.port.postMessage({ batch: JSON.parse(batch) as Batch });
  }

  function handlePanic(): void {
    for (const tab of tabs.values()) tab.port.postMessage({ crashed: true });
  }

  function handleSuperseded(): void {
    for (const tab of tabs.values()) tab.port.postMessage({ superseded: true });
  }

  return { attach, deliver, handlePanic, handleSuperseded };
}
