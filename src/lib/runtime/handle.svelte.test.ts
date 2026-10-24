// @vitest-environment happy-dom

import { expect, test, vi } from 'vitest';

import { FakeRuntime } from '#lib/test-support/fake-runtime.js';

import { SliceHandle } from './handle.svelte.js';

const LAYOUT = { items: [], loaded: true };
const TARGET = { slice: 'sidebar', key: null };

test('opens, closes and follows the same slice again', async () => {
  const runtime = new FakeRuntime({ sidebar: LAYOUT });
  const handle = new SliceHandle('sidebar', null, () => runtime.client());
  expect(handle.view).toBeUndefined();
  await handle.open();
  expect(handle.view).toEqual(LAYOUT);
  handle.close();
  expect(handle.view).toBeUndefined();
  await handle.open();
  expect(handle.view).toEqual(LAYOUT);
  expect(runtime.unsubscribed).toHaveLength(1);
});

test('holds an action until the subscription opens', async () => {
  const runtime = new FakeRuntime({ sidebar: LAYOUT });
  const handle = new SliceHandle('sidebar', null, () => runtime.client());
  void handle.open();
  const action = { type: 'write' as const, items: [] };
  await handle.dispatch(action);
  expect(runtime.dispatched).toEqual([{ target: TARGET, action }]);
  expect(handle.view).toEqual(LAYOUT);
});

test('dispatches while the initial snapshot is pending', async () => {
  const runtime = new FakeRuntime({ sidebar: LAYOUT });
  const snapshot = Promise.withResolvers<undefined>();
  const subscribe = runtime.subscribe;
  vi.spyOn(runtime, 'subscribe').mockImplementation(async (request) => {
    const answer = await subscribe(request);
    await snapshot.promise;
    return answer;
  });
  const handle = new SliceHandle('sidebar', null, () => runtime.client());
  const opening = handle.open();
  const action = { type: 'write' as const, items: [] };
  try {
    await vi.waitFor(() => {
      expect(runtime.subscribed).toEqual([TARGET]);
    });
    await handle.dispatch(action);
    expect(runtime.dispatched).toEqual([{ target: TARGET, action }]);
  } finally {
    snapshot.resolve(undefined);
    await opening;
    handle.close();
  }
});

test('actions keep their order across the initial snapshot', async () => {
  const runtime = new FakeRuntime({ sidebar: LAYOUT });
  const snapshot = Promise.withResolvers<undefined>();
  const subscribe = runtime.subscribe;
  vi.spyOn(runtime, 'subscribe').mockImplementation(async (request) => {
    const answer = await subscribe(request);
    await snapshot.promise;
    return answer;
  });
  const handle = new SliceHandle('sidebar', null, () => runtime.client());
  const opening = handle.open();
  const firstAction = { type: 'write' as const, items: [] };
  const lastAction = { ...firstAction, items: [{ kind: 'space' as const, room_id: '!last:x' }] };
  const first = handle.dispatch(firstAction);
  try {
    await vi.waitFor(() => {
      expect(runtime.subscribed).toHaveLength(1);
    });
    await handle.dispatch(lastAction);
    snapshot.resolve(undefined);
    await Promise.all([first, opening]);
    expect(runtime.dispatched.map(({ action }) => action)).toEqual([firstAction, lastAction]);
  } finally {
    snapshot.resolve(undefined);
    await Promise.all([first, opening]);
    handle.close();
  }
});

test('can retry an open that failed', async () => {
  const runtime = new FakeRuntime({ sidebar: LAYOUT });
  let tries = 0;
  const handle = new SliceHandle('sidebar', null, () => {
    if (++tries === 1) return Promise.reject(new Error('not yet'));
    return runtime.client();
  });
  await expect(handle.open()).rejects.toThrow('not yet');
  await handle.open();
  expect(handle.view).toEqual(LAYOUT);
});

test('observes view changes and notices of its own slice', async () => {
  const runtime = new FakeRuntime({ sidebar: LAYOUT });
  const changed = vi.fn();
  const noticed = vi.fn();
  const handle = new SliceHandle('sidebar', null, () => runtime.client(), {
    onChange: changed,
    onNotice: noticed,
  });
  await handle.open();
  changed.mockClear();
  runtime.set('sidebar', { items: [{ kind: 'space', room_id: '!room:x' }], loaded: true });
  runtime.notice('sidebar', { type: 'save_failed' });
  runtime.notice('rooms', { type: 'save_failed' });
  expect(changed).toHaveBeenCalledTimes(1);
  expect(noticed).toHaveBeenCalledOnce();
  expect(noticed).toHaveBeenCalledWith({ type: 'save_failed' });
});
