// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test } from 'vitest';

import { FakeRuntime } from '#lib/test-support/fake-runtime.js';

import { reactive } from './reactive.svelte.js';

test('an effect that reads the state runs again when a patch changes it, and stops with the effect', async () => {
  const runtime = new FakeRuntime({ demo: { count: 1 } });
  const client = await runtime.client();
  const subscription = client.subscribe<{ count: number }>({ slice: 'demo', key: null });
  await subscription.loaded;
  const state = reactive(subscription);
  const seen: (number | undefined)[] = [];

  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(state.current?.count);
    });
  });
  flushSync();
  runtime.set('demo', { count: 2 });
  flushSync();
  stop();
  runtime.set('demo', { count: 3 });
  flushSync();

  expect(seen).toEqual([1, 2]);
});
