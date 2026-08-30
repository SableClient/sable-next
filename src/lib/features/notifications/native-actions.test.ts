import { expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
  addPluginListener: vi.fn(),
}));

import type { NativeNotificationAction } from '#lib/platform/native-notifications.js';

import { performNotificationAction } from './native-actions';

type Replier = Parameters<typeof performNotificationAction>[0];

function core(accountId = '@me:example.org') {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const markRead = vi.fn().mockResolvedValue(undefined);
  const switchAccount = vi.fn().mockResolvedValue(undefined);
  const client = {
    session: { account_id: accountId },
    commands: { sendMessage, markRead },
    switchAccount,
  } as unknown as Replier;

  return { client, sendMessage, markRead, switchAccount };
}

function action(overrides: Partial<NativeNotificationAction> = {}): NativeNotificationAction {
  return {
    actionId: 'sable-reply',
    text: 'on my way',
    userId: '@me:example.org',
    roomId: '!room:example.org',
    eventId: '$event:example.org',
    ...overrides,
  };
}

test('a reply is sent and the room is read', async () => {
  const { client, sendMessage, markRead } = core();
  await performNotificationAction(client, action(), false);

  expect(sendMessage).toHaveBeenCalledWith('!room:example.org', 'on my way');
  expect(markRead).toHaveBeenCalledWith('!room:example.org', '$event:example.org', false);
});

test('marking read sends no message', async () => {
  const { client, sendMessage, markRead } = core();
  await performNotificationAction(
    client,
    action({ actionId: 'sable-mark-read', text: null }),
    true
  );

  expect(sendMessage).not.toHaveBeenCalled();
  expect(markRead).toHaveBeenCalledWith('!room:example.org', '$event:example.org', true);
});

test('a blank reply and an unknown action do nothing', async () => {
  const { client, sendMessage, markRead } = core();
  await performNotificationAction(client, action({ text: null }), false);
  await performNotificationAction(client, action({ actionId: 'sable-snooze' }), false);

  expect(sendMessage).not.toHaveBeenCalled();
  expect(markRead).not.toHaveBeenCalled();
});

test('an action for another account switches to it first', async () => {
  const { client, sendMessage, switchAccount } = core('@other:example.org');
  await performNotificationAction(client, action(), false);

  expect(switchAccount).toHaveBeenCalledWith('@me:example.org');
  expect(sendMessage).toHaveBeenCalled();
});
