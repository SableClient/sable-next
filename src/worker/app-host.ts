import type { AppEvent, Batch, Subscribed } from '#src/generated/protocol';
import type { AppMessage, AppRequest } from './app-protocol';

/** The calls of the wasm `SableApp`, which speak JSON. */
export interface AppApi {
  handshake(): string;
  subscribe(request: string): Promise<string>;
  unsubscribe(sub: number): Promise<void>;
  resync(sub: number): Promise<string>;
  range(sub: number, window: string): Promise<string>;
  dispatch(target: string, action: string): Promise<void>;
  request(target: string, action: string): Promise<bigint>;
  nextBatch(): Promise<string>;
}

export type TabPort = {
  postMessage(message: AppMessage): void;
  onmessage: ((message: MessageEvent<AppRequest>) => unknown) | null;
  start(): void;
};

interface Tab {
  port: TabPort;
  subs: Set<number>;
  reqs: Set<number>;
  closed: boolean;
  watching: AbortController;
}

function tabGone(tab: string, signal: AbortSignal): Promise<void> {
  return navigator.locks
    .request(`sable-runtime-tab-${tab}`, { signal }, () => undefined)
    .then(() => undefined);
}

/** The wasm app rejects with the code of an `FfiError` as a string. */
function errorCode(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : 'invalid';
}

/**
 * Serves the tabs of one worker from one `App`. Each tab is a subscriber: the
 * host remembers which tab asked for each subscription and request, sends it
 * only their events, and releases what it holds when the tab goes away.
 */
export function createAppHost(app: Promise<AppApi>, gone: typeof tabGone = tabGone) {
  const tabs = new Set<Tab>();
  const subOwners = new Map<number, Tab>();
  const reqOwners = new Map<number, Tab>();
  // Events can come out of the app before the call that created their subscription or request returns.
  let issuing = 0;
  let early: AppEvent[] = [];
  let lastTick = 0;

  function route(events: AppEvent[], tick: number): void {
    const perTab = new Map<Tab, AppEvent[]>();
    const give = (tab: Tab, event: AppEvent) => {
      const own = perTab.get(tab);
      if (own) own.push(event);
      else perTab.set(tab, [event]);
    };
    for (const event of events) {
      if (event.type === 'notice') {
        for (const tab of tabs) give(tab, event);
        continue;
      }
      const owners = event.type === 'reply' ? reqOwners : subOwners;
      const tab = owners.get(event.type === 'reply' ? event.req : event.sub);
      if (tab) {
        give(tab, event);
        if (event.type === 'reply') reqOwners.delete(event.req);
      } else if (issuing > 0) {
        early.push(event);
      }
    }
    for (const [tab, own] of perTab) {
      const batch: Batch = { tick, events: own };
      tab.port.postMessage({ batch });
    }
  }

  function replayEarly(): void {
    const held = early;
    early = [];
    route(held, lastTick);
  }

  async function pump(): Promise<void> {
    const api = await app;
    for (;;) {
      const batch = JSON.parse(await api.nextBatch()) as Batch;
      lastTick = batch.tick;
      route(batch.events, batch.tick);
    }
  }

  pump().catch((error: unknown) => {
    console.debug('[sable worker] the app stopped delivering batches', error);
  });

  async function serve(tab: Tab, request: Exclude<AppRequest, { op: 'hello' }>) {
    const api = await app;
    const json = JSON.stringify;
    const owned = (sub: number) => {
      if (subOwners.get(sub) !== tab) throw new Error('unknown_sub');
    };
    switch (request.op) {
      case 'handshake':
        return JSON.parse(api.handshake()) as unknown;
      case 'subscribe': {
        issuing++;
        try {
          const subscribed = JSON.parse(await api.subscribe(json(request.request))) as Subscribed;
          if (tab.closed) {
            await api.unsubscribe(subscribed.sub);
            return subscribed;
          }
          subOwners.set(subscribed.sub, tab);
          tab.subs.add(subscribed.sub);
          return subscribed;
        } finally {
          issuing--;
        }
      }
      case 'unsubscribe':
        owned(request.sub);
        subOwners.delete(request.sub);
        tab.subs.delete(request.sub);
        return api.unsubscribe(request.sub);
      case 'resync':
        owned(request.sub);
        return JSON.parse(await api.resync(request.sub)) as unknown;
      case 'range':
        owned(request.sub);
        return JSON.parse(await api.range(request.sub, json(request.window))) as unknown;
      case 'dispatch':
        return api.dispatch(json(request.target), json(request.action));
      case 'request': {
        issuing++;
        try {
          const req = Number(await api.request(json(request.target), json(request.action)));
          if (!tab.closed) {
            reqOwners.set(req, tab);
            tab.reqs.add(req);
          }
          return req;
        } finally {
          issuing--;
        }
      }
    }
  }

  async function release(tab: Tab): Promise<void> {
    if (tab.closed) return;
    tab.closed = true;
    tab.watching.abort();
    tabs.delete(tab);
    for (const req of tab.reqs) reqOwners.delete(req);
    const api = await app;
    for (const sub of tab.subs) {
      subOwners.delete(sub);
      await api.unsubscribe(sub);
    }
  }

  function attach(port: TabPort): void {
    const tab: Tab = {
      port,
      subs: new Set(),
      reqs: new Set(),
      closed: false,
      watching: new AbortController(),
    };
    tabs.add(tab);
    port.onmessage = ({ data }) => {
      if (data.op === 'hello') {
        gone(data.tab, tab.watching.signal).then(
          () => release(tab),
          () => undefined
        );
      } else {
        const { id } = data;
        serve(tab, data)
          .then(
            (ok) => {
              port.postMessage({ id, ok });
            },
            (error: unknown) => {
              port.postMessage({ id, error: errorCode(error) });
            }
          )
          .finally(replayEarly);
      }
    };
    port.start();
  }

  function handlePanic(): void {
    for (const tab of tabs) tab.port.postMessage({ crashed: true });
  }

  function handleSuperseded(): void {
    for (const tab of tabs) tab.port.postMessage({ superseded: true });
  }

  return { attach, handlePanic, handleSuperseded };
}
