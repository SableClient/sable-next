// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { AccountDirectory } from './account-directory.svelte';

function fakeCore() {
  const state = $state({ session: { account_id: 'a1' } });
  const userProfile = vi.fn((userId: string) =>
    Promise.resolve({ display_name: `${state.session.account_id}:${userId}`, avatar_url: null })
  );
  const core = {
    get session() {
      return state.session;
    },
    userProfile,
  } as unknown as CoreClient;
  return {
    core,
    userProfile,
    switchTo: (id: string) => {
      state.session = { account_id: id };
    },
  };
}

test('an account switch reads through without writing during the read', async () => {
  const { core, userProfile, switchTo } = fakeCore();
  const directory = new AccountDirectory(core);
  const names: string[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      names.push(directory.identity('@b:x').displayName);
    });
  });
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(names.at(-1)).toBe('a1:@b:x');
  });

  switchTo('a2');
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(names.at(-1)).toBe('a2:@b:x');
  });

  switchTo('a1');
  flushSync();
  expect(names.at(-1)).toBe('a1:@b:x');
  expect(userProfile).toHaveBeenCalledTimes(2);
  stop();
});
