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
  NativeNotificationOpener,
  performNotificationAction,
} from './native-actions';

type Replier = Parameters<typeof performNotificationAction>[0];

function core(accountId = 'account-me') {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const markRead = vi.fn().mockResolvedValue(undefined);
  const switchAccount = vi.fn();
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
  switchAccount.mockImplementation((selectedId: string) => {
    client.session = accounts.find(
      (account) => account.account_id === selectedId
    ) as Replier['session'];
    return Promise.resolve();
  });

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
  await performNotificationAction(client, action());

  expect(sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ room_id: '!room:example.org', body: 'on my way' })
  );
  expect(markRead).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_id: '$event:example.org',
    thread_root: null,
    subscription: null,
    fully_read: true,
  });
});

test('marking read sends no message', async () => {
  const { client, sendMessage, markRead } = core();
  await performNotificationAction(client, action({ actionId: 'sable-mark-read', text: null }));

  expect(sendMessage).not.toHaveBeenCalled();
  expect(markRead).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_id: '$event:example.org',
    thread_root: null,
    subscription: null,
    fully_read: true,
  });
});

test('a blank reply and an unknown action do nothing', async () => {
  const { client, sendMessage, markRead } = core();
  await performNotificationAction(client, action({ text: null }));
  await performNotificationAction(client, action({ actionId: 'sable-snooze' }));

  expect(sendMessage).not.toHaveBeenCalled();
  expect(markRead).not.toHaveBeenCalled();
});

test('an action for another account switches to it first', async () => {
  const { client, sendMessage, switchAccount } = core('account-other');
  await performNotificationAction(client, action());

  expect(switchAccount).toHaveBeenCalledWith('account-me');
  expect(sendMessage).toHaveBeenCalled();
});

test('opening an inactive account notification switches before navigating', async () => {
  const { client, switchAccount } = core();
  const open = vi.fn();

  await expect(
    new NativeNotificationOpener(client).open(target({ userId: '@other:example.org' }), open)
  ).resolves.toBe('opened');

  expect(switchAccount).toHaveBeenCalledWith('account-other');
  expect(open).toHaveBeenCalledWith(
    '!room:example.org',
    '$event:example.org',
    expect.any(Function)
  );
  expect(switchAccount).toHaveBeenCalledBefore(open);
});

test('a notification whose account cannot be switched to stays on the current room', async () => {
  const { client, switchAccount } = core();
  switchAccount.mockRejectedValue(new Error('failed'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const open = vi.fn();

  await expect(
    new NativeNotificationOpener(client).open(target({ userId: '@other:example.org' }), open)
  ).resolves.toBe('switch_failed');

  expect(open).not.toHaveBeenCalled();
});

test('a notification for an account that is gone opens nothing', async () => {
  const { client, switchAccount } = core();
  const open = vi.fn();

  await expect(
    new NativeNotificationOpener(client).open(target({ userId: '@gone:example.org' }), open)
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

test('a switch that returns without selecting the account does not open a room', async () => {
  const { client, switchAccount } = core();
  switchAccount.mockResolvedValue(undefined);
  const open = vi.fn();

  await expect(
    new NativeNotificationOpener(client).open(target({ userId: '@other:example.org' }), open)
  ).resolves.toBe('switch_failed');
  expect(open).not.toHaveBeenCalled();
});

test('a newer tap supersedes an older room lookup', async () => {
  const { client } = core();
  const opener = new NativeNotificationOpener(client);
  const started = Promise.withResolvers<undefined>();
  const listed = Promise.withResolvers<undefined>();
  const navigated: string[] = [];
  const older = opener.open(
    target({ roomId: '!older:example.org' }),
    async (roomId, _eventId, isCurrent) => {
      started.resolve(undefined);
      await listed.promise;
      if (isCurrent()) navigated.push(roomId);
    }
  );
  await started.promise;
  await opener.open(target({ roomId: '!newer:example.org' }), (roomId, _eventId, isCurrent) => {
    if (isCurrent()) navigated.push(roomId);
  });
  listed.resolve(undefined);

  await expect(older).resolves.toBe('superseded');
  expect(navigated).toEqual(['!newer:example.org']);
});

test('a tap for the current account waits for an older account switch before selecting it', async () => {
  const { client, switchAccount } = core();
  const opener = new NativeNotificationOpener(client);
  const started = Promise.withResolvers<undefined>();
  const switched = Promise.withResolvers<undefined>();
  switchAccount.mockImplementation(async (accountId: string) => {
    if (accountId === 'account-other') {
      started.resolve(undefined);
      await switched.promise;
    }
    client.session = client.accounts.find(
      (account) => account.account_id === accountId
    ) as Replier['session'];
  });
  const openOld = vi.fn();
  const openNew = vi.fn();
  const older = opener.open(target({ userId: '@other:example.org' }), openOld);
  await started.promise;
  const newer = opener.open(target(), openNew);
  expect(switchAccount).toHaveBeenCalledTimes(1);
  switched.resolve(undefined);

  await expect(older).resolves.toBe('superseded');
  await expect(newer).resolves.toBe('opened');
  expect(switchAccount.mock.calls).toEqual([['account-other'], ['account-me']]);
  expect(openOld).not.toHaveBeenCalled();
  expect(openNew).toHaveBeenCalledOnce();
  expect(client.session?.account_id).toBe('account-me');
});

test.each(['cancel', 'account change'] as const)(
  '%s invalidates an in-flight room lookup',
  async (reason) => {
    const { client } = core();
    const opener = new NativeNotificationOpener(client);
    const started = Promise.withResolvers<undefined>();
    const listed = Promise.withResolvers<undefined>();
    const navigate = vi.fn();
    const opening = opener.open(target(), async (_roomId, _eventId, isCurrent) => {
      started.resolve(undefined);
      await listed.promise;
      if (isCurrent()) navigate();
    });
    await started.promise;
    if (reason === 'cancel') opener.cancel();
    else client.session = client.accounts[1] as Replier['session'];
    listed.resolve(undefined);

    await expect(opening).resolves.toBe('superseded');
    expect(navigate).not.toHaveBeenCalled();
  }
);

test('a failed older switch does not stop a newer tap from selecting its account', async () => {
  const { client, switchAccount } = core();
  const opener = new NativeNotificationOpener(client);
  const started = Promise.withResolvers<undefined>();
  const switched = Promise.withResolvers<undefined>();
  switchAccount.mockImplementationOnce(async () => {
    started.resolve(undefined);
    await switched.promise;
    throw new Error('switch failed');
  });
  const open = vi.fn();
  const older = opener.open(target({ userId: '@other:example.org' }), vi.fn());
  await started.promise;
  const newer = opener.open(target(), open);
  switched.resolve(undefined);

  await expect(older).resolves.toBe('superseded');
  await expect(newer).resolves.toBe('opened');
  expect(open).toHaveBeenCalledOnce();
});

test('changing accounts while sending a reply does not mark the other account read', async () => {
  const { client, sendMessage, markRead } = core();
  const started = Promise.withResolvers<undefined>();
  const sent = Promise.withResolvers<undefined>();
  sendMessage.mockImplementation(async () => {
    started.resolve(undefined);
    await sent.promise;
  });
  const replying = performNotificationAction(client, action());
  await started.promise;
  client.session = client.accounts[1] as Replier['session'];
  sent.resolve(undefined);
  await replying;
  expect(markRead).not.toHaveBeenCalled();
});
