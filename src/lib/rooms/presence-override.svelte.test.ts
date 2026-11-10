import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent, PresenceOverrideView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';

import {
  ownPresence,
  ownStatusMessage,
  presenceChoices,
  presenceOverride,
  setOwnPresence,
} from './presence-override.svelte';

function fakeCore(stored: PresenceOverrideView | null) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const setPresenceOverride = vi.fn(({ override }: { override: PresenceOverrideView }) =>
    Promise.resolve(override)
  );
  const core = {
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rpc: {
      account: { presenceOverride: vi.fn(() => Promise.resolve(stored)), setPresenceOverride },
    },
  } as unknown as CoreClient;
  return {
    core,
    setPresenceOverride,
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    },
    setStored: (next: PresenceOverrideView | null) => {
      stored = next;
    },
  };
}

beforeEach(() => {
  setPreference('presence', 'online');
  setPreference('presenceStatusMessage', '');
});

afterEach(() => {
  presenceOverride.stop();
});

test('a legacy server keeps presence in the local preferences and offers no busy', async () => {
  const fake = fakeCore(null);
  presenceOverride.start(fake.core);
  await vi.waitFor(() => {
    expect(fake.core.rpc.account.presenceOverride).toHaveBeenCalled();
  });

  await setOwnPresence('unavailable', ' brb ');

  expect(presenceChoices()).not.toContain('busy');
  expect(preferences.presence).toBe('unavailable');
  expect(preferences.presenceStatusMessage).toBe('brb');
  expect(fake.setPresenceOverride).not.toHaveBeenCalled();
});

test('a revised server reads and writes the shared override instead of the preferences', async () => {
  const fake = fakeCore({ state: 'busy', status_message: 'In a meeting' });
  presenceOverride.start(fake.core);
  await vi.waitFor(() => {
    expect(presenceOverride.supported).toBe(true);
  });

  expect(presenceChoices()).toContain('busy');
  expect(ownPresence()).toBe('busy');
  expect(ownStatusMessage()).toBe('In a meeting');

  await setOwnPresence('online', '');

  expect(fake.setPresenceOverride).toHaveBeenCalledWith({
    override: { state: null, status_message: null },
  });
  expect(ownPresence()).toBe('online');
  expect(preferences.presence).toBe('online');
});

test('another client changing the override is picked up', async () => {
  const fake = fakeCore({ state: null, status_message: null });
  presenceOverride.start(fake.core);
  await vi.waitFor(() => {
    expect(presenceOverride.supported).toBe(true);
  });

  fake.setStored({ state: 'unavailable', status_message: 'lunch' });
  fake.emit({
    type: 'account_data_changed',
    event_type: 'org.continuwuity.presence_v2.msc4532.presence.persistent',
  });

  await vi.waitFor(() => {
    expect(ownPresence()).toBe('unavailable');
  });
  expect(ownStatusMessage()).toBe('lunch');
});
