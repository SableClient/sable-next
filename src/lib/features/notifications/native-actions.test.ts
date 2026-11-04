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

import {
  inviteNotificationAction,
  openNativeNotification,
  performNotificationAction,
} from './native-actions';

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
    rpc: { messages: { send: sendMessage }, timeline: { markRead } },
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
  await performNotificationAction(client, action(), () => false);

  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ room_id: '!room:example.org', body: 'on my way' })
  );
  expect(markRead).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_id: '$event:example.org',
    private_receipt: false,
    thread_root: null,
    subscription: null,
    fully_read: true,
  });
});

test('marking read sends no message', async () => {
  const { client, sendMessage, markRead } = core();
  await performNotificationAction(
    client,
    action({ actionId: 'sable-mark-read', text: null }),
    () => true
  );

  expect(sendMessage).not.toHaveBeenCalled();
  expect(markRead).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_id: '$event:example.org',
    private_receipt: true,
    thread_root: null,
    subscription: null,
    fully_read: true,
  });
});

test('a blank reply and an unknown action do nothing', async () => {
  const { client, sendMessage, markRead } = core();
  await performNotificationAction(client, action({ text: null }), () => false);
  await performNotificationAction(client, action({ actionId: 'sable-snooze' }), () => false);

  expect(sendMessage).not.toHaveBeenCalled();
  expect(markRead).not.toHaveBeenCalled();
});

test('an action for another account switches to it first', async () => {
  const { client, sendMessage, switchAccount } = core('account-other');
  await performNotificationAction(client, action(), () => false);

  expect(switchAccount).toHaveBeenCalledWith('account-me');
  expect(sendMessage).toHaveBeenCalled();
});

test('opening an inactive account notification switches before navigating', async () => {
  const { client, switchAccount } = core();
  const open = vi.fn();

  await expect(
    openNativeNotification(client, target({ userId: '@other:example.org' }), open)
  ).resolves.toBe('opened');

  expect(switchAccount).toHaveBeenCalledWith('account-other');
  expect(open).toHaveBeenCalledWith('!room:example.org', '$event:example.org');
  expect(switchAccount).toHaveBeenCalledBefore(open);
});

test('a notification whose account cannot be switched to stays on the current room', async () => {
  const { client, switchAccount } = core();
  switchAccount.mockRejectedValue(new Error('failed'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const open = vi.fn();

  await expect(
    openNativeNotification(client, target({ userId: '@other:example.org' }), open)
  ).resolves.toBe('switch_failed');

  expect(open).not.toHaveBeenCalled();
});

test('a notification for an account that is gone opens nothing', async () => {
  const { client, switchAccount } = core();
  const open = vi.fn();

  await expect(
    openNativeNotification(client, target({ userId: '@gone:example.org' }), open)
  ).resolves.toBe('unknown_account');

  expect(switchAccount).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

test('the invite buttons map to an answer and nothing else does', () => {
  const action = (actionId: string): NativeNotificationAction => ({
    userId: '@me:example.org',
    roomId: '!room:example.org',
    eventId: null,
    actionId,
    text: null,
  });
  expect(inviteNotificationAction(action('sable-invite-accept'))).toBe('accept');
  expect(inviteNotificationAction(action('sable-invite-decline'))).toBe('decline');
  expect(inviteNotificationAction(action('sable-reply'))).toBeNull();
  expect(inviteNotificationAction(action('sable-call-answer'))).toBeNull();
});

test('resolves receipt policy after selecting the notification account', async () => {
  const { client, switchAccount, markRead } = core('account-other');
  let privateReceipt = false;
  switchAccount.mockImplementation(() => {
    privateReceipt = true;
    return Promise.resolve();
  });
  await performNotificationAction(client, action(), () => privateReceipt);
  expect(switchAccount).toHaveBeenCalledWith('account-me');
  expect(markRead).toHaveBeenCalledWith(expect.objectContaining({ private_receipt: true }));
});
