import { expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(),
  addPluginListener: vi.fn(),
}));

import type {
  NativeNotificationAction,
  NativeNotificationTarget,
} from '#lib/platform/native-notifications.js';

import { openNativeNotification, performNotificationAction } from './native-actions';

type Replier = Parameters<typeof performNotificationAction>[0];

function core(accountId = 'account-me') {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const markRead = vi.fn().mockResolvedValue(undefined);
  const switchAccount = vi.fn().mockResolvedValue(undefined);
  const accounts = [
    { account_id: 'account-me', user_id: '@me:example.org' },
    { account_id: 'account-other', user_id: '@other:example.org' },
  ];
  const client = {
    session: accounts.find((account) => account.account_id === accountId),
    accounts,
    commands: { sendMessage, markRead },
    switchAccount,
  } as unknown as Replier;

  return { client, sendMessage, markRead, switchAccount };
}

function target(overrides: Partial<NativeNotificationTarget> = {}): NativeNotificationTarget {
  return {
    userId: '@me:example.org',
    roomId: '!room:example.org',
    eventId: '$event:example.org',
    ...overrides,
  };
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
  const { client, sendMessage, switchAccount } = core('account-other');
  await performNotificationAction(client, action(), false);

  expect(switchAccount).toHaveBeenCalledWith('account-me');
  expect(sendMessage).toHaveBeenCalled();
});

test('opening an inactive account notification switches before navigating', async () => {
  const { client, switchAccount } = core();
  const open = vi.fn();

  await openNativeNotification(client, target({ userId: '@other:example.org' }), open);

  expect(switchAccount).toHaveBeenCalledWith('account-other');
  expect(open).toHaveBeenCalledWith('!room:example.org');
  expect(switchAccount).toHaveBeenCalledBefore(open);
});
