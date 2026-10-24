import { describe, expect, it, vi } from 'vitest';

import type {
  AppEvent,
  Batch,
  Handshake,
  Outcome,
  ReqId,
  Snapshot,
  SubId,
  Subscribed,
  SubscribeRequest,
  Target,
  Window,
} from '#src/generated/protocol';
import { WIRE_SCHEMA } from '#src/generated/protocol';
import forms from '../../../tests/fixtures/wire/forms.json';
import { connect, RequestError, type Client } from './client';
import { WireMismatchError } from './handshake';
import type { Link } from './link';

const target = { slice: 'demo', key: null };
const snapshot = (state: unknown, rev = 0, epoch = 0): Snapshot => ({ rev, epoch, state });

class FakeLink implements Link {
  handshakeValue: Handshake = { schema: WIRE_SCHEMA, slices: ['demo'] };
  nextSub = 1;
  states = new Map<SubId, Snapshot>();
  subscribed: SubscribeRequest[] = [];
  unsubscribed: SubId[] = [];
  resyncs: SubId[] = [];
  ranges: (Window | null)[] = [];
  dispatched: [Target, unknown][] = [];
  requested: ReqId[] = [];
  listener: (batch: Batch) => void = () => undefined;
  tick = 0;
  initial: Snapshot = snapshot({ total: 2, items: ['a', 'b'] });
  hold: Promise<void> | null = null;

  handshake = () => Promise.resolve(this.handshakeValue);
  subscribe = async (request: SubscribeRequest): Promise<Subscribed> => {
    this.subscribed.push(request);
    const sub = this.nextSub++;
    await this.hold;
    return { sub, snapshot: this.initial };
  };
  unsubscribe = (sub: SubId) => {
    this.unsubscribed.push(sub);
    return Promise.resolve();
  };
  resync = async (sub: SubId) => {
    this.resyncs.push(sub);
    await this.hold;
    return this.states.get(sub) ?? this.initial;
  };
  range = (_: SubId, window: Window | null) => {
    this.ranges.push(window);
    return Promise.resolve(snapshot({ window }));
  };
  dispatch = (target: Target, action: unknown) => {
    this.dispatched.push([target, action]);
    return Promise.resolve();
  };
  request = async (): Promise<ReqId> => {
    await this.hold;
    return this.requested[this.requested.length - 1] ?? 7;
  };
  onBatch = (listener: (batch: Batch) => void) => {
    this.listener = listener;
    return () => undefined;
  };
  restarted: () => void = () => undefined;
  onRestart = (listener: () => void) => {
    this.restarted = listener;
    return () => undefined;
  };

  push(...events: AppEvent[]): void {
    this.listener({ tick: ++this.tick, events });
  }
}

const patch = (sub: SubId, rev: number, ops: unknown[], epoch = 0): AppEvent =>
  ({ type: 'patch', sub, rev, epoch, ops }) as AppEvent;
const set = (field: string, value: unknown) => ({ op: 'fields', fields: { [field]: value } });
const reply = (req: ReqId, outcome: Outcome, epoch = 0): AppEvent => ({
  type: 'reply',
  req,
  epoch,
  outcome,
});
const flush = () => new Promise<void>((done) => setTimeout(done, 0));

async function setup() {
  const link = new FakeLink();
  const onError = vi.fn();
  const client = await connect(link, { needed: ['demo'], onError });
  return { link, client, onError };
}

async function open(client: Client) {
  const sub = client.subscribe<{ total: number; items: string[] }>(target);
  await sub.loaded;
  return sub;
}

describe('connect', () => {
  it('throws a typed mismatch when the schema differs', async () => {
    const link = new FakeLink();
    link.handshakeValue = { schema: forms.handshake.schema, slices: ['demo'] };
    const error = await connect(link).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WireMismatchError);
    expect((error as WireMismatchError).mismatch.kind).toBe('schema');
  });

  it('throws when a needed slice is missing', async () => {
    const link = new FakeLink();
    link.handshakeValue.slices = [];
    await expect(connect(link, { needed: ['demo'] })).rejects.toMatchObject({
      mismatch: { kind: 'missing_slices', missing: ['demo'] },
    });
  });
});

describe('subscription', () => {
  it('tells its openers each time the state arrives from a subscribe, and not once they are gone', async () => {
    const { link, client } = await setup();
    const sub = client.subscribe<{ total: number; items: string[] }>(target);
    const opened = vi.fn();
    const gone = vi.fn();
    sub.onOpen(opened);
    sub.onOpen(gone)();
    await sub.loaded;

    expect(opened).toHaveBeenCalledTimes(1);
    expect(sub.get()).toEqual({ total: 2, items: ['a', 'b'] });

    link.restarted();
    await flush();

    expect(opened).toHaveBeenCalledTimes(2);
    expect(gone).not.toHaveBeenCalled();
  });

  it('holds the snapshot and applies the fixture batch with one notification', async () => {
    const { link, client } = await setup();
    const sub = await open(client);
    const before = sub.get();
    const listener = vi.fn();
    sub.subscribe(listener);

    link.listener(forms.patch as Batch);

    expect(sub.get()).toEqual({ total: 3, items: ['a', 'b', 'c'] });
    expect(sub.get()).toBe(sub.get());
    expect(sub.get()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps the reference and stays silent when nothing it follows changed', async () => {
    const { link, client } = await setup();
    const sub = await open(client);
    const listener = vi.fn();
    sub.subscribe(listener);
    const before = sub.get();

    link.push(patch(2, 1, [set('total', 9)]));

    expect(sub.get()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('applies a batch to each subscription it touches and lets none see another’s events', async () => {
    const { link, client } = await setup();
    const first = await open(client);
    const second = await open(client);
    const heardFirst = vi.fn();
    const heardSecond = vi.fn();
    first.subscribe(heardFirst);
    second.subscribe(heardSecond);

    link.push(
      patch(1, 1, [set('total', 5)]),
      patch(1, 2, [set('total', 6)]),
      patch(2, 1, [set('total', 8)])
    );

    expect(first.get()?.total).toBe(6);
    expect(second.get()?.total).toBe(8);
    expect(heardFirst).toHaveBeenCalledTimes(1);
    expect(heardSecond).toHaveBeenCalledTimes(1);
  });

  it('drops a patch from an epoch it has moved past and one it already has', async () => {
    const { link, client } = await setup();
    link.initial = snapshot({ total: 1, items: [] }, 4, 2);
    const sub = await open(client);

    link.push(patch(1, 5, [set('total', 9)], 1), patch(1, 4, [set('total', 9)], 2));

    expect(sub.get()?.total).toBe(1);
    expect(link.resyncs).toEqual([]);
  });

  it('asks for a snapshot on a gap and replaces the state with it', async () => {
    const { link, client } = await setup();
    const sub = await open(client);
    link.states.set(1, snapshot({ total: 7, items: [] }, 3));

    link.push(patch(1, 3, [set('total', 1)]));
    await flush();

    expect(link.resyncs).toEqual([1]);
    expect(sub.get()?.total).toBe(7);
  });

  it('holds patches that arrive while a snapshot is on its way and applies the newer ones', async () => {
    const { link, client } = await setup();
    const sub = await open(client);
    link.states.set(1, snapshot({ total: 7, items: [] }, 3));
    let release = () => {};
    link.hold = new Promise((done) => (release = done));

    link.push({ type: 'resync', sub: 1, epoch: 0 });
    link.push(patch(1, 3, [set('total', 70)]), patch(1, 4, [set('total', 8)]));
    expect(sub.get()?.total).toBe(2);
    release();
    await flush();

    expect(sub.get()?.total).toBe(8);
  });

  it('resyncs into a new epoch and ignores a resync from an old one', async () => {
    const { link, client } = await setup();
    const sub = await open(client);
    link.states.set(1, snapshot({ total: 0, items: [] }, 0, 1));

    link.push({ type: 'resync', sub: 1, epoch: 1 });
    await flush();
    link.push({ type: 'resync', sub: 1, epoch: 0 });
    await flush();

    expect(link.resyncs).toEqual([1]);
    expect(sub.get()?.total).toBe(0);
  });

  it('resyncs when a patch does not fit the state', async () => {
    const { link, client, onError } = await setup();
    await open(client);

    link.push(patch(1, 1, [{ op: 'list', field: 'items', diffs: [{ Remove: { index: 99 } }] }]));
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(link.resyncs).toEqual([1]);
  });

  it('applies patches that arrive before the subscribe call returns', async () => {
    const { link, client } = await setup();
    let release = () => {};
    link.hold = new Promise((done) => (release = done));
    const sub = client.subscribe<{ total: number }>(target);
    await flush();

    link.push(patch(1, 1, [set('total', 5)]), patch(1, 0, [set('total', 99)]));
    release();
    await sub.loaded;

    expect(sub.get()?.total).toBe(5);
  });

  it('follows a window and sends it again when it subscribes again', async () => {
    const { link, client } = await setup();
    const sub = client.subscribe(target, { start: 0, end: 10 });
    await sub.loaded;

    await sub.range({ start: 5, end: 15 });
    expect(sub.get()).toEqual({ window: { start: 5, end: 15 } });
    await client.reconnect();
    await sub.loaded;
    await flush();

    expect(link.ranges).toEqual([{ start: 5, end: 15 }]);
    expect(link.subscribed.map((request) => request.window)).toEqual([
      { start: 0, end: 10 },
      { start: 5, end: 15 },
    ]);
  });

  it('unsubscribes on close and ignores later events', async () => {
    const { link, client } = await setup();
    const sub = await open(client);
    await sub.close();

    link.push(patch(1, 1, [set('total', 5)]));

    expect(link.unsubscribed).toEqual([1]);
    expect(sub.get()?.total).toBe(2);
  });

  it('unsubscribes at once when closed before the subscribe call returns', async () => {
    const { link, client } = await setup();
    let release = () => {};
    link.hold = new Promise((done) => (release = done));
    const sub = client.subscribe(target);
    await flush();
    await sub.close();
    release();
    await flush();

    expect(link.unsubscribed).toEqual([1]);
  });
});

describe('request', () => {
  async function answered(batch: unknown) {
    const { link, client } = await setup();
    const pending = client.request(target, {});
    await flush();
    link.listener(batch as Batch);
    return pending;
  }

  it('resolves with the value of an ok reply', async () => {
    await expect(answered(forms.reply_ok)).resolves.toEqual({ id: 'x' });
  });

  it('rejects with the core’s error', async () => {
    await expect(answered(forms.reply_rpc_error)).rejects.toMatchObject({
      reason: { kind: 'rpc', error: { code: 'denied' } },
    });
  });

  it('rejects with the reason a request was lost', async () => {
    await expect(answered(forms.reply_lost)).rejects.toMatchObject({
      reason: { kind: 'lost', reason: 'epoch_changed' },
    });
  });

  it('settles a request whose reply arrives before its id does', async () => {
    const { link, client } = await setup();
    let release = () => {};
    link.hold = new Promise((done) => (release = done));
    const pending = client.request(target, {});
    link.listener(forms.reply_ok as Batch);
    release();
    await expect(pending).resolves.toEqual({ id: 'x' });
  });

  it('settles once and ignores a second reply', async () => {
    const { link, client } = await setup();
    const pending = client.request(target, {});
    await flush();
    link.push(reply(7, { status: 'ok', value: 1 }));
    link.push(reply(7, { status: 'ok', value: 2 }));
    await expect(pending).resolves.toBe(1);
  });

  it('rejects when the call itself fails', async () => {
    const { link, client } = await setup();
    link.request = () => Promise.reject(new Error('unknown_slice'));
    await expect(client.request(target, {})).rejects.toThrow('unknown_slice');
  });
});

describe('notices', () => {
  it('delivers a notice and drops one from an old epoch', async () => {
    const { link, client } = await setup();
    const heard = vi.fn();
    client.onNotice(heard);

    link.push({ type: 'resync', sub: 9, epoch: 2 });
    link.listener(forms.notice as Batch);
    link.push({ type: 'notice', slice: 's', notice: { type: 'saved' }, epoch: 2 });

    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ notice: { type: 'saved' } }));
  });
});

describe('reconnect', () => {
  it('rejects pending requests and subscribes again keeping the state meanwhile', async () => {
    const { link, client } = await setup();
    const sub = await open(client);
    const pending = client.request(target, {}).catch((error: unknown) => error);
    await flush();

    link.initial = snapshot({ total: 5, items: [] });
    let release = () => {};
    link.hold = new Promise((done) => (release = done));
    const reconnected = client.reconnect();
    await flush();
    await expect(pending).resolves.toEqual(new RequestError({ kind: 'restarted' }));
    expect(sub.get()?.total).toBe(2);
    release();
    await reconnected;

    expect(sub.get()?.total).toBe(5);
    expect(link.subscribed).toHaveLength(2);
  });

  it('reconnects by itself when the link restarts, and reports a mismatch it finds', async () => {
    const { link, client, onError } = await setup();
    const sub = await open(client);

    link.initial = snapshot({ total: 9, items: [] });
    link.restarted();
    await flush();
    expect(sub.get()?.total).toBe(9);

    link.handshakeValue = { schema: forms.handshake.schema, slices: [] };
    link.restarted();
    await flush();
    expect(onError).toHaveBeenCalledWith(expect.any(WireMismatchError));
  });

  it('does not dispatch into a new runtime before subscriptions reopen', async () => {
    const { link, client } = await setup();
    await open(client);
    let release = () => {};
    link.hold = new Promise((done) => (release = done));

    link.restarted();
    const dispatched = client.dispatch(target, { type: 'add', n: 1 });
    await flush();
    expect(link.dispatched).toEqual([]);

    release();
    await dispatched;
    expect(link.subscribed).toHaveLength(2);
    expect(link.dispatched).toEqual([[target, { type: 'add', n: 1 }]]);
  });

  it('lets a subscription that lost its first subscribe to a restart still load', async () => {
    const { link, client } = await setup();
    const subscribe = link.subscribe;
    link.subscribe = () => {
      link.subscribe = subscribe;
      link.restarted();
      return Promise.reject(new Error('the worker restarted'));
    };
    const sub = client.subscribe(target);
    await sub.loaded;

    expect(sub.get()).toEqual({ total: 2, items: ['a', 'b'] });
  });

  it('throws the mismatch of the runtime it came back to', async () => {
    const { link, client } = await setup();
    link.handshakeValue = { schema: forms.handshake.schema, slices: [] };
    await expect(client.reconnect()).rejects.toBeInstanceOf(WireMismatchError);
  });
});
