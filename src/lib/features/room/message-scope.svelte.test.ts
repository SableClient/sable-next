import { expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';
import { RoomScopes } from './message-scope.svelte.js';

function setup() {
  const listeners = new Set<(event: CoreEvent) => void>();
  const core = {
    session: null,
    subscribeEvents(listener: (event: CoreEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commands: {
      roomCosmetics: vi.fn(() => Promise.resolve({ users: [], space_id: null })),
      pinnedEvents: vi.fn(() => Promise.resolve([])),
      setPinned: vi.fn(() => Promise.resolve([])),
    },
  };
  return { core, listeners, scopes: new RoomScopes(core) };
}

test('shares active room scopes and unsubscribes when their last preview closes', () => {
  const { scopes, listeners, core } = setup();
  const first = scopes.acquire('!room:example.org');
  const second = scopes.acquire('!room:example.org');
  expect(first.cosmetics).toBe(second.cosmetics);
  expect(listeners.size).toBe(1);
  expect(core.commands.roomCosmetics).toHaveBeenCalledTimes(1);

  first.release();
  first.release();
  expect(listeners.size).toBe(1);
  second.release();
  expect(listeners.size).toBe(0);

  const reopened = scopes.acquire('!room:example.org');
  expect(reopened.cosmetics).not.toBe(first.cosmetics);
  reopened.release();
});

test('does not accumulate subscriptions as previews visit more rooms', () => {
  const { scopes, listeners } = setup();
  for (let index = 0; index < 100; index += 1) {
    const scope = scopes.acquire(`!room${index}:example.org`);
    expect(listeners.size).toBe(1);
    scope.release();
    expect(listeners.size).toBe(0);
  }
});

test('layout cleanup unsubscribes all scopes and tolerates later consumer cleanup', () => {
  const { scopes, listeners } = setup();
  const first = scopes.acquire('!first:example.org');
  const second = scopes.acquire('!second:example.org');
  scopes.dispose();
  expect(listeners.size).toBe(0);
  const reopened = scopes.acquire('!first:example.org');
  first.release();
  second.release();
  expect(listeners.size).toBe(1);
  reopened.release();
  expect(listeners.size).toBe(0);
});
