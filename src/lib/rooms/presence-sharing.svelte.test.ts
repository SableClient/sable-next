import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent, PresenceSharingView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { presenceSharing } from './presence-sharing.svelte';

function sharing(overrides: Partial<PresenceSharingView> = {}): PresenceSharingView {
  return {
    hint_event_type: 'org.continuwuity.presence_v2.msc4495.room.presence_sharing',
    configured: true,
    share_locally: false,
    allowed_users: [],
    denied_users: [],
    allowed_rooms: [],
    denied_servers: [],
    prompted_users: [],
    prompted_rooms: [],
    ...overrides,
  };
}

function fakeCore(stored: PresenceSharingView | null) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const editPresenceSharing = vi.fn(() =>
    Promise.resolve(sharing({ allowed_users: ['@b:example.org'] }))
  );
  const core = {
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rpc: {
      account: { presenceSharing: vi.fn(() => Promise.resolve(stored)), editPresenceSharing },
    },
  } as unknown as CoreClient;
  return {
    core,
    editPresenceSharing,
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    },
    setStored: (next: PresenceSharingView | null) => {
      stored = next;
    },
  };
}

afterEach(() => {
  presenceSharing.stop();
});

test('stays unsupported when the server has no selective presence', async () => {
  const fake = fakeCore(null);
  presenceSharing.start(fake.core);
  await Promise.resolve();

  expect(presenceSharing.supported).toBe(false);
  expect(presenceSharing.userSharing('@a:example.org')).toBeNull();
});

test('follows changes to the unstable account data', async () => {
  const fake = fakeCore(sharing({ allowed_users: ['@a:example.org'] }));
  presenceSharing.start(fake.core);
  await vi.waitFor(() => {
    expect(presenceSharing.userSharing('@a:example.org')).toBe('allow');
  });

  fake.setStored(sharing({ denied_users: ['@a:example.org'], allowed_rooms: ['!r:example.org'] }));
  fake.emit({
    type: 'account_data_changed',
    event_type: 'org.continuwuity.presence_v2.msc4495.presence.sharing',
  });

  await vi.waitFor(() => {
    expect(presenceSharing.userSharing('@a:example.org')).toBe('deny');
  });
  expect(presenceSharing.roomAllowed('!r:example.org')).toBe(true);
});

test('an edit takes the view the core returns', async () => {
  const fake = fakeCore(sharing());
  presenceSharing.start(fake.core);
  const version = presenceSharing.version;

  await presenceSharing.edit({ kind: 'user', user_id: '@b:example.org', sharing: 'allow' });

  expect(fake.editPresenceSharing).toHaveBeenCalledWith({
    edit: { kind: 'user', user_id: '@b:example.org', sharing: 'allow' },
  });
  expect(presenceSharing.userSharing('@b:example.org')).toBe('allow');
  expect(presenceSharing.version).toBeGreaterThan(version);
});
