// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test } from 'vitest';

import { untrackFetch } from './untracked-fetch.js';

test('an effect that fetches does not depend on what a fetch wrapper reads', () => {
  let navigating = $state<string | null>(null);
  const target = {
    fetch: (() => {
      void navigating;
      return Promise.resolve(new Response());
    }) as typeof fetch,
  };
  untrackFetch(target);

  let runs = 0;
  const stop = $effect.root(() => {
    $effect(() => {
      runs += 1;
      void target.fetch('ipc://localhost/plugin');
    });
  });
  flushSync();

  navigating = 'link';
  flushSync();
  navigating = null;
  flushSync();

  expect(runs).toBe(1);
  stop();
});
