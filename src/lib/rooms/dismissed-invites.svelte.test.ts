import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { DISMISSED_INVITES_EVENT, dismissedInvites } from './dismissed-invites.svelte';

function fakeCore(stored: unknown) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const accountData = vi.fn(() => Promise.resolve(stored));
  const setAccountData = vi.fn((_type: string, content: unknown) => {
    stored = content;
    return Promise.resolve();
  });
  const core = {
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commands: { accountData, setAccountData },
  } as unknown as CoreClient;
  return {
    core,
    accountData,
    setAccountData,
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    },
    setStored: (next: unknown) => {
      stored = next;
    },
  };
}

afterEach(() => {
  dismissedInvites.stop();
});

test('reads the list v1 writes and follows remote changes', async () => {
  const fake = fakeCore({ roomIds: ['!a:example.org'] });
  dismissedInvites.start(fake.core);
  await vi.waitFor(() => {
    expect(dismissedInvites.has('!a:example.org')).toBe(true);
  });
  expect(fake.accountData).toHaveBeenCalledWith(DISMISSED_INVITES_EVENT);

  fake.setStored({ roomIds: ['!b:example.org'] });
  fake.emit({ type: 'account_data_changed', event_type: DISMISSED_INVITES_EVENT });
  await vi.waitFor(() => {
    expect(dismissedInvites.has('!b:example.org')).toBe(true);
  });
  expect(dismissedInvites.has('!a:example.org')).toBe(false);
});

test('dismissing and restoring write the whole list back', async () => {
  const fake = fakeCore(null);
  dismissedInvites.start(fake.core);

  await dismissedInvites.dismiss('!a:example.org');
  expect(fake.setAccountData).toHaveBeenLastCalledWith(DISMISSED_INVITES_EVENT, {
    roomIds: ['!a:example.org'],
  });

  await dismissedInvites.restore('!a:example.org');
  expect(fake.setAccountData).toHaveBeenLastCalledWith(DISMISSED_INVITES_EVENT, { roomIds: [] });
  expect(dismissedInvites.has('!a:example.org')).toBe(false);
});

test('a failed write puts the previous list back', async () => {
  const fake = fakeCore(null);
  fake.setAccountData.mockRejectedValueOnce(new Error('offline'));
  dismissedInvites.start(fake.core);

  await expect(dismissedInvites.dismiss('!a:example.org')).rejects.toThrow('offline');
  expect(dismissedInvites.has('!a:example.org')).toBe(false);
});
