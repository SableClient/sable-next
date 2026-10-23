import { afterEach, describe, expect, it, vi } from 'vitest';

import { releaseProxy, wrap } from 'comlink';

import { createAppHost, type AppApi, type TabPort } from './app-host';
import type { AppMessage, AppRemote } from './app-protocol';

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

const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

function fakeTab() {
  const sent: AppMessage[] = [];
  const channel = new MessageChannel();
  ports.push(channel.port1, channel.port2);
  channel.port1.onmessage = ({ data }: MessageEvent<AppMessage>) => {
    if ('batch' in data || 'crashed' in data || 'superseded' in data) sent.push(data);
  };
  const api = wrap<AppRemote>(channel.port1);
  const port: TabPort = {
    postMessage: (message) => {
      channel.port2.postMessage(message);
    },
    get onmessage() {
      return channel.port2.onmessage;
    },
    set onmessage(handler) {
      channel.port2.onmessage = handler;
    },
    start: () => {
      channel.port2.start();
    },
  };
  return {
    port,
    sent,
    api,
    hello: (tab: string) => {
      channel.port1.postMessage({ op: 'hello', tab });
    },
  };
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

    await one.api.subscribe(target);
    await two.api.subscribe(target);

    expect(app.open.mock.calls).toEqual([[1], [2]]);
    expect(app.subscribe.mock.calls.map(([tab]) => tab)).toEqual([1, 2]);
  });

  it('answers each call with what the app returned, decoded', async () => {
    const { app, host } = setup();
    const tab = fakeTab();
    host.attach(tab.port);

    expect(await tab.api.handshake()).toEqual({ schema: 's', slices: ['demo'] });
    expect(await tab.api.subscribe(target)).toEqual({ sub: 1 });
    expect(await tab.api.resync(1)).toEqual({ rev: 1 });
    expect(await tab.api.range(1, { start: 0, end: 5 })).toEqual({ rev: 2 });
    expect(await tab.api.request(target, {})).toBe(100);
    expect(app.range).toHaveBeenCalledWith(1, 1, '{"start":0,"end":5}');
  });

  it('answers a call the app rejects with its code', async () => {
    const { app, host } = setup();
    const tab = fakeTab();
    host.attach(tab.port);
    app.subscribe.mockRejectedValueOnce('unknown_slice');
    app.unsubscribe.mockRejectedValueOnce(new Error('unknown_sub'));

    await expect(tab.api.subscribe(target)).rejects.toThrow('unknown_slice');
    await expect(tab.api.unsubscribe(9)).rejects.toThrow('unknown_sub');
  });

  it('hands the app’s batch for a tab to that tab alone', async () => {
    const { host } = setup();
    const [one, two] = [fakeTab(), fakeTab()];
    host.attach(one.port);
    host.attach(two.port);

    await two.api.handshake();
    host.deliver(2, JSON.stringify({ tick: 4, events: [] }));

    await flush();
    expect(one.sent).toEqual([]);
    expect(two.sent).toEqual([{ batch: { tick: 4, events: [] } }]);
  });

  it('lets go of a tab that went away and stops delivering to it', async () => {
    const { app, host, gone } = setup();
    const tab = fakeTab();
    host.attach(tab.port);
    tab.hello('a');
    await vi.waitFor(() => {
      expect(gone.has('a')).toBe(true);
    });

    gone.get('a')?.();
    await flush();
    host.deliver(1, JSON.stringify({ tick: 1, events: [] }));

    expect(app.close).toHaveBeenCalledWith(1);
    expect(tab.sent).toEqual([]);
  });

  it('tells every tab when the worker panics or a newer tab takes over', async () => {
    const { host } = setup();
    const [one, two] = [fakeTab(), fakeTab()];
    host.attach(one.port);
    host.attach(two.port);

    await two.api.handshake();
    host.handlePanic();
    host.handleSuperseded();

    await flush();
    expect(one.sent).toEqual([{ crashed: true }, { superseded: true }]);
    expect(two.sent).toEqual(one.sent);
  });

  it('closes a tab when its Comlink endpoint is released', async () => {
    const { app, host } = setup();
    const tab = fakeTab();
    host.attach(tab.port);
    await tab.api.handshake();
    tab.api[releaseProxy]();
    await vi.waitFor(() => {
      expect(app.close).toHaveBeenCalledWith(1);
    });
    host.deliver(1, JSON.stringify({ tick: 1, events: [] }));
    expect(tab.sent).toEqual([]);
  });
});
