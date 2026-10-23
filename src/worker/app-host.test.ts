import { describe, expect, it, vi } from 'vitest';

import { createAppHost, type AppApi, type TabPort } from './app-host';
import type { AppMessage, AppRequest } from './app-protocol';

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

function fakeApp() {
  return {
    handshake: vi.fn(() => JSON.stringify({ schema: 's', slices: ['demo'] })),
    open: vi.fn<AppApi['open']>(() => Promise.resolve()),
    close: vi.fn<AppApi['close']>(() => Promise.resolve()),
    subscribe: vi.fn<AppApi['subscribe']>(() => Promise.resolve(JSON.stringify({ sub: 1 }))),
    unsubscribe: vi.fn<AppApi['unsubscribe']>(() => Promise.resolve()),
    resync: vi.fn(() => Promise.resolve(JSON.stringify({ rev: 1 }))),
    range: vi.fn<AppApi['range']>(() => Promise.resolve(JSON.stringify({ rev: 2 }))),
    dispatch: vi.fn(() => Promise.resolve()),
    request: vi.fn(() => Promise.resolve(BigInt(100))),
  } satisfies AppApi;
}

function fakeTab() {
  const sent: AppMessage[] = [];
  const port: TabPort = {
    postMessage: (message) => void sent.push(message),
    onmessage: null,
    start: () => undefined,
  };
  let nextId = 1;
  const call = async (request: Record<string, unknown>) => {
    const id = nextId++;
    port.onmessage?.({ data: { id, ...request } } as MessageEvent<AppRequest>);
    await flush();
    return sent.find((message) => 'id' in message && message.id === id);
  };
  const hello = (tab: string) =>
    port.onmessage?.({ data: { op: 'hello', tab } } as MessageEvent<AppRequest>);
  return { port, sent, call, hello };
}

function setup() {
  const app = fakeApp();
  const gone = new Map<string, () => void>();
  const host = createAppHost(
    Promise.resolve(app),
    (tab) => new Promise<void>((resolve) => gone.set(tab, resolve))
  );
  return { app, host, gone };
}

const target = { slice: 'demo', key: null };

describe('createAppHost', () => {
  it('opens each port as a tab of its own before it serves it', async () => {
    const { app, host } = setup();
    const [one, two] = [fakeTab(), fakeTab()];
    host.attach(one.port);
    host.attach(two.port);

    await one.call({ op: 'subscribe', request: target });
    await two.call({ op: 'subscribe', request: target });

    expect(app.open.mock.calls).toEqual([[1], [2]]);
    expect(app.subscribe.mock.calls.map(([tab]) => tab)).toEqual([1, 2]);
  });

  it('answers each call with what the app returned, decoded', async () => {
    const { app, host } = setup();
    const tab = fakeTab();
    host.attach(tab.port);

    expect(await tab.call({ op: 'handshake' })).toEqual({
      id: 1,
      ok: { schema: 's', slices: ['demo'] },
    });
    expect(await tab.call({ op: 'subscribe', request: target })).toEqual({ id: 2, ok: { sub: 1 } });
    expect(await tab.call({ op: 'resync', sub: 1 })).toEqual({ id: 3, ok: { rev: 1 } });
    expect(await tab.call({ op: 'range', sub: 1, window: { start: 0, end: 5 } })).toEqual({
      id: 4,
      ok: { rev: 2 },
    });
    expect(await tab.call({ op: 'request', target, action: {} })).toEqual({ id: 5, ok: 100 });
    expect(app.range).toHaveBeenCalledWith(1, 1, '{"start":0,"end":5}');
  });

  it('answers a call the app rejects with its code', async () => {
    const { app, host } = setup();
    const tab = fakeTab();
    host.attach(tab.port);
    app.subscribe.mockRejectedValueOnce('unknown_slice');
    app.unsubscribe.mockRejectedValueOnce(new Error('unknown_sub'));

    expect(await tab.call({ op: 'subscribe', request: target })).toEqual({
      id: 1,
      error: 'unknown_slice',
    });
    expect(await tab.call({ op: 'unsubscribe', sub: 9 })).toEqual({ id: 2, error: 'unknown_sub' });
  });

  it('hands the app’s batch for a tab to that tab alone', () => {
    const { host } = setup();
    const [one, two] = [fakeTab(), fakeTab()];
    host.attach(one.port);
    host.attach(two.port);

    host.deliver(2, JSON.stringify({ tick: 4, events: [] }));

    expect(one.sent).toEqual([]);
    expect(two.sent).toEqual([{ batch: { tick: 4, events: [] } }]);
  });

  it('lets go of a tab that went away and stops delivering to it', async () => {
    const { app, host, gone } = setup();
    const tab = fakeTab();
    host.attach(tab.port);
    tab.hello('a');

    gone.get('a')?.();
    await flush();
    host.deliver(1, JSON.stringify({ tick: 1, events: [] }));

    expect(app.close).toHaveBeenCalledWith(1);
    expect(tab.sent).toEqual([]);
  });

  it('tells every tab when the worker panics or a newer tab takes over', () => {
    const { host } = setup();
    const [one, two] = [fakeTab(), fakeTab()];
    host.attach(one.port);
    host.attach(two.port);

    host.handlePanic();
    host.handleSuperseded();

    expect(one.sent).toEqual([{ crashed: true }, { superseded: true }]);
    expect(two.sent).toEqual(one.sent);
  });
});
