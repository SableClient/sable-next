import { describe, expect, it, vi } from 'vitest';

import type { AppEvent, Batch } from '#src/generated/protocol';
import { createAppHost, type AppApi, type TabPort } from './app-host';
import type { AppMessage, AppRequest } from './app-protocol';

const flush = () => new Promise<void>((done) => setTimeout(done, 0));

function fakeApp() {
  const batches: (string | Error)[] = [];
  let wake: () => void = () => undefined;
  let nextSub = 1;
  let nextReq = 100;
  let subscribeGate: Promise<void> | null = null;
  const api = {
    handshake: () => JSON.stringify({ schema: 's', slices: ['demo'] }),
    subscribe: vi.fn(async () => {
      const sub = nextSub++;
      await subscribeGate;
      return JSON.stringify({ sub, snapshot: { rev: 0, epoch: 0, state: { sub } } });
    }),
    unsubscribe: vi.fn(() => Promise.resolve()),
    resync: vi.fn(() => Promise.resolve(JSON.stringify({ rev: 1, epoch: 0, state: {} }))),
    range: vi.fn(() => Promise.resolve(JSON.stringify({ rev: 1, epoch: 0, state: {} }))),
    dispatch: vi.fn(() => Promise.resolve()),
    request: vi.fn(() => Promise.resolve(BigInt(nextReq++))),
    nextBatch: () =>
      new Promise<string>((resolve) => {
        const take = () => {
          const next = batches.shift();
          if (next === undefined) wake = take;
          else resolve(next as string);
        };
        take();
      }),
  } satisfies AppApi;
  return {
    api,
    push(batch: Batch) {
      batches.push(JSON.stringify(batch));
      wake();
    },
    holdSubscribes() {
      let release = () => {};
      subscribeGate = new Promise((done) => (release = done));
      return () => {
        subscribeGate = null;
        release();
      };
    },
  };
}

function fakeTab() {
  const sent: AppMessage[] = [];
  const port: TabPort = {
    postMessage: (message) => void sent.push(message),
    onmessage: null,
    start: () => undefined,
  };
  const send = (request: AppRequest) =>
    port.onmessage?.({ data: request } as MessageEvent<AppRequest>);
  let nextId = 1;
  const call = async (request: Record<string, unknown>) => {
    const id = nextId++;
    send({ id, ...request } as AppRequest);
    await flush();
    return sent.find((message) => 'id' in message && message.id === id);
  };
  const batches = () => sent.flatMap((message) => ('batch' in message ? [message.batch] : []));
  return { port, sent, send, call, batches };
}

const patch = (sub: number, rev = 1): AppEvent => ({ type: 'patch', sub, rev, epoch: 0, ops: [] });

function setup() {
  const app = fakeApp();
  const gone = new Map<string, () => void>();
  const host = createAppHost(
    Promise.resolve(app.api),
    (tab) => new Promise<void>((resolve) => gone.set(tab, resolve))
  );
  const attach = () => {
    const tab = fakeTab();
    host.attach(tab.port);
    return tab;
  };
  return { app, host, attach, gone };
}

describe('createAppHost', () => {
  it('sends each tab only the events of its own subscriptions', async () => {
    const { app, attach } = setup();
    const [one, two] = [attach(), attach()];
    await one.call({ op: 'subscribe', request: { slice: 'demo', key: null } });
    await two.call({ op: 'subscribe', request: { slice: 'demo', key: null } });

    app.push({ tick: 7, events: [patch(1), patch(2, 5), patch(1, 2)] });
    await flush();

    expect(one.batches()).toEqual([{ tick: 7, events: [patch(1), patch(1, 2)] }]);
    expect(two.batches()).toEqual([{ tick: 7, events: [patch(2, 5)] }]);
  });

  it('routes a reply to the tab that asked, once', async () => {
    const { app, attach } = setup();
    const [one, two] = [attach(), attach()];
    const answer = await two.call({
      op: 'request',
      target: { slice: 'demo', key: null },
      action: {},
    });
    expect(answer).toEqual({ id: 1, ok: 100 });

    const reply: AppEvent = {
      type: 'reply',
      req: 100,
      epoch: 0,
      outcome: { status: 'ok', value: 1 },
    };
    app.push({ tick: 1, events: [reply] });
    app.push({ tick: 2, events: [reply] });
    await flush();

    expect(one.batches()).toEqual([]);
    expect(two.batches()).toEqual([{ tick: 1, events: [reply] }]);
  });

  it('delivers an event that outran the call that created its subscription, after the answer', async () => {
    const { app, attach } = setup();
    const tab = attach();
    const release = app.holdSubscribes();
    tab.send({ id: 1, op: 'subscribe', request: { slice: 'demo', key: null } });
    await flush();

    app.push({ tick: 1, events: [patch(1)] });
    await flush();
    expect(tab.sent).toEqual([]);
    release();
    await flush();

    expect(tab.sent.map((message) => Object.keys(message)[0])).toEqual(['id', 'batch']);
  });

  it('refuses a tab the subscription of another', async () => {
    const { app, attach } = setup();
    const [one, two] = [attach(), attach()];
    await one.call({ op: 'subscribe', request: { slice: 'demo', key: null } });

    expect(await two.call({ op: 'resync', sub: 1 })).toEqual({ id: 1, error: 'unknown_sub' });
    expect(await two.call({ op: 'unsubscribe', sub: 1 })).toEqual({ id: 2, error: 'unknown_sub' });
    expect(app.api.resync).not.toHaveBeenCalled();
  });

  it('releases the subscriptions of a tab that went away', async () => {
    const { app, attach, gone } = setup();
    const tab = attach();
    tab.send({ op: 'hello', tab: 'a' });
    await tab.call({ op: 'subscribe', request: { slice: 'demo', key: null } });

    gone.get('a')?.();
    await flush();
    app.push({ tick: 1, events: [patch(1)] });
    await flush();

    expect(app.api.unsubscribe).toHaveBeenCalledWith(1);
    expect(tab.batches()).toEqual([]);
  });

  it('shows every tab a notice and tells them when the worker panics', async () => {
    const { app, host, attach } = setup();
    const [one, two] = [attach(), attach()];
    const notice: AppEvent = { type: 'notice', slice: 'demo', stage: 's', text: 't', epoch: 0 };

    app.push({ tick: 1, events: [notice] });
    await flush();
    host.handlePanic();

    expect(one.sent).toEqual([{ batch: { tick: 1, events: [notice] } }, { crashed: true }]);
    expect(two.sent).toEqual(one.sent);
  });

  it('answers a call the app rejects with its code', async () => {
    const { app, attach } = setup();
    const tab = attach();
    app.api.subscribe.mockRejectedValueOnce('unknown_slice');

    expect(await tab.call({ op: 'subscribe', request: { slice: 'x', key: null } })).toEqual({
      id: 1,
      error: 'unknown_slice',
    });
  });
});
