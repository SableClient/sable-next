import type { Batch } from '#src/generated/protocol';
import type { AppMessage, AppRequest } from './app-protocol';

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
  postMessage(message: AppMessage): void;
  onmessage: ((message: MessageEvent<AppRequest>) => unknown) | null;
  start(): void;
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

/** The app rejects with the code of an `FfiError` as a string, or as the message of an error. */
function errorCode(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : 'invalid';
}

export function createAppHost(app: Promise<AppApi>, gone: typeof tabGone = tabGone) {
  const tabs = new Map<number, Tab>();
  let nextTab = 1;

  async function serve(id: number, request: Exclude<AppRequest, { op: 'hello' }>) {
    const api = await app;
    const json = JSON.stringify;
    switch (request.op) {
      case 'handshake':
        return JSON.parse(api.handshake()) as unknown;
      case 'subscribe':
        return JSON.parse(await api.subscribe(id, json(request.request))) as unknown;
      case 'unsubscribe':
        return api.unsubscribe(id, request.sub);
      case 'resync':
        return JSON.parse(await api.resync(id, request.sub)) as unknown;
      case 'range':
        return JSON.parse(await api.range(id, request.sub, json(request.window))) as unknown;
      case 'dispatch':
        return api.dispatch(json(request.target), json(request.action));
      case 'request':
        return Number(await api.request(id, json(request.target), json(request.action)));
    }
  }

  async function release(id: number, tab: Tab): Promise<void> {
    if (tab.closed) return;
    tab.closed = true;
    tab.watching.abort();
    tabs.delete(id);
    await tab.opened;
    await (await app).close(id);
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
    port.onmessage = ({ data }) => {
      if (data.op === 'hello') {
        gone(data.tab, tab.watching.signal).then(
          () => release(id, tab),
          () => undefined
        );
      } else {
        const request = data.id;
        tab.opened
          .then(() => serve(id, data))
          .then(
            (ok) => {
              port.postMessage({ id: request, ok });
            },
            (error: unknown) => {
              port.postMessage({ id: request, error: errorCode(error) });
            }
          );
      }
    };
    port.start();
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
