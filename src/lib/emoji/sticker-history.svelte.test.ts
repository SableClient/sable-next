// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { setPreference } from '#lib/settings/preferences.svelte.js';
import type { CoreEvent, RecentUse } from '#src/generated/protocol';

import { STICKER_HISTORY_EVENT, StickerHistory } from './sticker-history.svelte.js';

type Params = { sync: boolean; legacy?: string[]; synced?: string[] };

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  setPreference('settingsSync', false);
  localStorage.clear();
  vi.useRealTimers();
});

function setup(answer: (params: Params) => Promise<RecentUse[]> = () => Promise.resolve([])) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const recentStickers = vi.fn(answer);
  const rememberSticker = vi.fn(() => Promise.resolve(null));
  const core = $state({
    session: { account_id: 'first' },
    rpc: { messages: { recentStickers, rememberSticker } },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  let history!: StickerHistory;
  stops.push(
    $effect.root(() => {
      history = new StickerHistory(
        core as unknown as ConstructorParameters<typeof StickerHistory>[0]
      );
    })
  );
  flushSync();
  return {
    history,
    core,
    recentStickers,
    rememberSticker,
    emit: (event_type: string) => {
      for (const listener of listeners) listener({ type: 'account_data_changed', event_type });
    },
  };
}

const wave = [{ key: 'wave', uses: 3, total: 3 }];
const party = [{ key: 'party', uses: 1, total: 1 }];

test('stays on the device while settings sync is off', () => {
  const { history, recentStickers, rememberSticker } = setup();
  history.remember('wave');
  expect(recentStickers.mock.calls.map(([params]) => params.sync)).toEqual([false]);
  expect(rememberSticker).toHaveBeenCalledWith({ key: 'wave', sync: false });
});

test('shows the local copy while the server answers', async () => {
  setPreference('settingsSync', true);
  const server = Promise.withResolvers<RecentUse[]>();
  const { history } = setup(({ sync }) => (sync ? server.promise : Promise.resolve(wave)));
  await vi.waitFor(() => {
    expect(history.current).toEqual(wave);
  });
  expect(history.loaded).toBe(false);
  server.resolve(party);
  await vi.waitFor(() => {
    expect(history.current).toEqual(party);
  });
  expect(history.loaded).toBe(true);
});

test('a slow local answer cannot replace the synced one', async () => {
  setPreference('settingsSync', true);
  const local = Promise.withResolvers<RecentUse[]>();
  const { history } = setup(({ sync }) => (sync ? Promise.resolve(party) : local.promise));
  await vi.waitFor(() => {
    expect(history.current).toEqual(party);
  });
  local.resolve(wave);
  await local.promise;
  expect(history.current).toEqual(party);
});

test('hands the old list over and drops it only once the core has saved it', async () => {
  localStorage.setItem('sable.composer.recentStickers', '["wave"]');
  const saved = Promise.withResolvers<RecentUse[]>();
  const { recentStickers } = setup(() => saved.promise);
  expect(recentStickers).toHaveBeenCalledWith({ sync: false, legacy: ['wave'] });
  expect(localStorage.getItem('sable.composer.recentStickers')).not.toBeNull();
  saved.resolve(wave);
  await vi.waitFor(() => {
    expect(localStorage.getItem('sable.composer.recentStickers')).toBeNull();
  });
});

test('keeps the old list when the core could not save it', async () => {
  localStorage.setItem('sable.composer.recentStickers', '["wave"]');
  const { recentStickers } = setup(() => Promise.reject(new Error('no store')));
  await vi.waitFor(() => {
    expect(recentStickers).toHaveBeenCalled();
  });
  expect(localStorage.getItem('sable.composer.recentStickers')).toBe('["wave"]');
});

test('switching accounts never shows the other history', async () => {
  const late = Promise.withResolvers<RecentUse[]>();
  const { history, core, recentStickers } = setup(() => late.promise);
  recentStickers.mockImplementation(() => Promise.resolve(party));
  core.session = { account_id: 'second' };
  flushSync();
  late.resolve(wave);
  await vi.waitFor(() => {
    expect(history.current).toEqual(party);
  });
});

test.each([STICKER_HISTORY_EVENT, 'dev.zirco.msc4483.account_data.key'])(
  'reloads after %s changes',
  (event) => {
    const { recentStickers, emit } = setup();
    emit(event);
    expect(recentStickers).toHaveBeenCalledTimes(2);
  }
);

test('recounts when another day starts', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T23:59:59Z'));
  const { recentStickers } = setup();
  await vi.advanceTimersByTimeAsync(1000);
  expect(recentStickers).toHaveBeenCalledTimes(2);
});
