import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { DISMISSED_INVITES_EVENT, dismissedInvites } from './dismissed-invites.svelte';

function fakeCore(stored: string[]) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const dismissedInvitesCommand = vi.fn(() => Promise.resolve(stored));
  const setInviteDismissed = vi.fn((roomId: string, dismissed: boolean) => {
    stored = dismissed ? [...stored, roomId] : stored.filter((entry) => entry !== roomId);
    return Promise.resolve(stored);
  });
  const core = {
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commands: { dismissedInvites: dismissedInvitesCommand, setInviteDismissed },
  } as unknown as CoreClient;
  return {
    core,
    setInviteDismissed,
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    },
    setStored: (next: string[]) => {
      stored = next;
    },
  };
}

afterEach(() => {
  dismissedInvites.stop();
});

test('reads the dismissed rooms and follows remote changes', async () => {
  const fake = fakeCore(['!a:example.org']);
  dismissedInvites.start(fake.core);
  await vi.waitFor(() => {
    expect(dismissedInvites.has('!a:example.org')).toBe(true);
  });

  fake.setStored(['!b:example.org']);
  fake.emit({ type: 'account_data_changed', event_type: DISMISSED_INVITES_EVENT });
  await vi.waitFor(() => {
    expect(dismissedInvites.has('!b:example.org')).toBe(true);
  });
  expect(dismissedInvites.has('!a:example.org')).toBe(false);
});

test('dismissing and restoring go through the core one room at a time', async () => {
  const fake = fakeCore([]);
  dismissedInvites.start(fake.core);

  await dismissedInvites.dismiss('!a:example.org');
  expect(fake.setInviteDismissed).toHaveBeenLastCalledWith('!a:example.org', true);
  expect(dismissedInvites.has('!a:example.org')).toBe(true);

  await dismissedInvites.restore('!a:example.org');
  expect(fake.setInviteDismissed).toHaveBeenLastCalledWith('!a:example.org', false);
  expect(dismissedInvites.has('!a:example.org')).toBe(false);
});

test('a failed write puts the previous list back', async () => {
  const fake = fakeCore([]);
  fake.setInviteDismissed.mockRejectedValueOnce(new Error('offline'));
  dismissedInvites.start(fake.core);

  await expect(dismissedInvites.dismiss('!a:example.org')).rejects.toThrow('offline');
  expect(dismissedInvites.has('!a:example.org')).toBe(false);
});
