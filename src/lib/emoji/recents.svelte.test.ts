// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';

import { RecentReactions, REACTION_HISTORY_EVENT } from './recents.svelte.js';

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  localStorage.clear();
  vi.useRealTimers();
});

function setup() {
  const listeners = new Set<(event: CoreEvent) => void>();
  const frequentReactions = vi.fn<() => Promise<string[]>>().mockResolvedValue(['🔥', '❤️']);
  const core = $state({
    session: { account_id: 'first' },
    rpc: { messages: { frequentReactions } },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  let history!: RecentReactions;
  stops.push(
    $effect.root(() => {
      history = new RecentReactions(
        core as unknown as ConstructorParameters<typeof RecentReactions>[0]
      );
    })
  );
  flushSync();
  return {
    history,
    core,
    frequentReactions,
    emit: () => {
      for (const listener of listeners)
        listener({ type: 'account_data_changed', event_type: REACTION_HISTORY_EVENT });
    },
  };
}

test('displays the core ranking and refreshes it when history changes', async () => {
  const fixture = setup();
  await vi.waitFor(() => {
    expect(fixture.history.current).toEqual(['🔥', '❤️']);
  });
  fixture.frequentReactions.mockResolvedValueOnce(['❤️', '🔥']);
  fixture.emit();
  await vi.waitFor(() => {
    expect(fixture.history.current).toEqual(['❤️', '🔥']);
  });
});

test('passes old local history to the core for migration', async () => {
  localStorage.setItem('sable-recent-reactions', JSON.stringify([['🐈', 4]]));
  localStorage.setItem(
    'sable.composer.recentEmotes',
    JSON.stringify(['mxc://example.org/wave', '🔥', 3])
  );
  const fixture = setup();
  expect(fixture.frequentReactions).toHaveBeenCalledWith({
    legacy: [['🐈', 4]],
    recent: ['mxc://example.org/wave', '🔥'],
  });
  await vi.waitFor(() => {
    expect(localStorage.getItem('sable-recent-reactions')).toBeNull();
    expect(localStorage.getItem('sable.composer.recentEmotes')).toBeNull();
  });
});

test('an older response cannot replace a newer ranking', async () => {
  const fixture = setup();
  const pending = Promise.withResolvers<string[]>();
  fixture.frequentReactions.mockReturnValueOnce(pending.promise);
  fixture.emit();
  fixture.frequentReactions.mockResolvedValueOnce(['🎉']);
  fixture.emit();
  await vi.waitFor(() => {
    expect(fixture.history.current).toEqual(['🎉']);
  });
  pending.resolve(['old']);
  await pending.promise;
  expect(fixture.history.current).toEqual(['🎉']);
});

test('switching accounts clears the previous ranking and ignores its pending response', async () => {
  const fixture = setup();
  await vi.waitFor(() => {
    expect(fixture.history.current).toEqual(['🔥', '❤️']);
  });
  const pending = Promise.withResolvers<string[]>();
  fixture.frequentReactions.mockReturnValueOnce(pending.promise);
  fixture.emit();
  fixture.frequentReactions.mockResolvedValueOnce(['🐈']);
  fixture.core.session = { account_id: 'second' };
  flushSync();
  expect(fixture.history.current).toEqual([]);
  await vi.waitFor(() => {
    expect(fixture.history.current).toEqual(['🐈']);
  });
  pending.resolve(['old']);
  await pending.promise;
  expect(fixture.history.current).toEqual(['🐈']);
});

test('a picker left open refreshes when another day starts', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T23:59:59Z'));
  const fixture = setup();
  await Promise.resolve();
  fixture.frequentReactions.mockResolvedValueOnce([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.history.current).toEqual([]);
  expect(fixture.frequentReactions).toHaveBeenCalledTimes(2);
});
