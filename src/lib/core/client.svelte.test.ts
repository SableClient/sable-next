import { expect, test, vi } from 'vitest';

import type { CoreEvent, SessionInfo } from '#src/generated/protocol';
import type { Transport } from '#src/transport';

import { createCoreClient } from './client.svelte.js';

const session: SessionInfo = {
  account_id: 'account-a',
  user_id: '@erwan:example.org',
  device_id: 'LAPTOP',
  homeserver: 'https://example.org',
  needs_reauth: false,
};

function fakeTransport(responses: Record<string, unknown> = {}) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const sent: { type: string }[] = [];
  const close = vi.fn();
  const send = vi.fn((command: { type: string }) => {
    sent.push(command);
    return Promise.resolve(responses[command.type] ?? {});
  });
  const transport = {
    send,
    subscribe: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    subscribeCrash: () => () => {},
    subscribeStall: () => () => {},
    setDebugLogs: vi.fn(),
    close,
    fetchMedia: vi.fn(),
    sendAttachment: vi.fn(),
    uploadMedia: vi.fn(),
  } as unknown as Transport;

  return {
    transport,
    send,
    sent,
    close,
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

test('a restore that returns a session leaves the client ready', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  expect(core.status).toBe('ready');
  expect(core.session?.user_id).toBe('@erwan:example.org');
  expect(core.accounts).toHaveLength(1);
});

test('a restore that returns no session reports signed out, not an error', async () => {
  const fake = fakeTransport({ restore: { session: null } });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  expect(core.status).toBe('signed-out');
  expect(core.session).toBeNull();
});

test('a transport that refuses to restore leaves the client signed out for relogin', async () => {
  const fake = fakeTransport();
  fake.transport.send = vi.fn(() => Promise.reject(new Error('worker gone')));
  const core = createCoreClient(() => fake.transport);

  await core.start();

  expect(core.status).toBe('signed-out');
  expect(core.session).toBeNull();
});

test('concurrent starts share one restore', async () => {
  const fake = fakeTransport({ restore: { session: null } });
  const core = createCoreClient(() => fake.transport);

  await Promise.all([core.start(), core.start(), core.start()]);

  expect(fake.sent.filter((command) => command.type === 'restore')).toHaveLength(1);
});

test('commands dispatch through the transport the client was given', async () => {
  const fake = fakeTransport({ restore: { session: null }, room_aliases: { aliases: ['#a:b'] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  await expect(core.commands.roomAliases('!room:example.org')).resolves.toEqual(['#a:b']);
  expect(fake.sent).toContainEqual({ type: 'room_aliases', room_id: '!room:example.org' });
});

test('sending an attachment forwards its rich caption, mentions, reply, and thread', async () => {
  const fake = fakeTransport();
  const sendAttachment = vi.fn<Transport['sendAttachment']>();
  fake.transport.sendAttachment = sendAttachment;
  const core = createCoreClient(() => fake.transport);
  const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });

  await core.commands.sendAttachment('!room:example.org', file, {
    caption: 'hey Member One :wave:',
    formattedCaption:
      'hey <a href="https://matrix.to/#/@one:example.org">Member One</a> <img data-mx-emoticon>',
    mentions: { userIds: ['@one:example.org'], room: true },
    inReplyTo: '$reply:example.org',
    threadRoot: '$thread:example.org',
    persona: {
      id: 'hatchy',
      display_name: 'Hatchy',
      avatar_url: null,
      pronouns: [],
      color_on_light: null,
      color_on_dark: null,
      has_fallback: false,
    },
  });

  expect(sendAttachment).toHaveBeenCalledWith({
    roomId: '!room:example.org',
    filename: 'report.pdf',
    mime: 'application/pdf',
    bytes: new TextEncoder().encode('pdf'),
    caption: 'hey Member One :wave:',
    formattedCaption:
      'hey <a href="https://matrix.to/#/@one:example.org">Member One</a> <img data-mx-emoticon>',
    mentions: ['@one:example.org'],
    mentionsRoom: true,
    inReplyTo: '$reply:example.org',
    info: null,
    threadRoot: '$thread:example.org',
    persona: {
      id: 'hatchy',
      display_name: 'Hatchy',
      avatar_url: null,
      pronouns: [],
      color_on_light: null,
      color_on_dark: null,
      has_fallback: false,
    },
  });
});

test('stopping clears the session and closes the transport', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  core.stop();

  expect(core.status).toBe('idle');
  expect(core.session).toBeNull();
  expect(fake.close).toHaveBeenCalled();
});

test('core events from the transport reach client state', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  const status = { type: 'sync_status', state: 'running' } as unknown as CoreEvent;
  fake.emit(status);
  expect(core.sync).toBe(status);

  fake.emit({ type: 'devices_changed', devices: [] } as unknown as CoreEvent);
  expect(core.deviceList).toEqual([]);
});

test('the sync status outlives the reset the session replacement performs', async () => {
  const fake = fakeTransport({
    restore: { session },
    list_accounts: { accounts: [session] },
    sync_status: { status: { state: 'live' } },
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  await vi.waitFor(() => {
    expect(core.sync?.state).toBe('live');
  });
});

test('a cancellation for an unknown verification flow does not open the verification dialog', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  const unsubscribe = core.subscribeEvents(() => {});

  fake.emit({
    type: 'verification',
    user_id: session.user_id,
    flow_id: 'stale-flow',
    state: { phase: 'cancelled', reason: 'm.user' },
  });

  expect(core.verification).toBeNull();

  fake.emit({
    type: 'verification',
    user_id: session.user_id,
    flow_id: 'active-flow',
    state: { phase: 'requested', is_self: true, initiated_by_us: false },
  });
  fake.emit({
    type: 'verification',
    user_id: session.user_id,
    flow_id: 'active-flow',
    state: { phase: 'cancelled', reason: 'm.user' },
  });

  expect(core.verification).toEqual({
    flowId: 'active-flow',
    state: { phase: 'cancelled', reason: 'm.user' },
  });
  unsubscribe();
});

test('a session ending clears the session and looks for a fallback account', async () => {
  const fake = fakeTransport({
    restore: { session },
    list_accounts: { accounts: [session] },
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  fake.emit({ type: 'session_ended' } as unknown as CoreEvent);

  expect(core.session).toBeNull();
  expect(core.status).toBe('authenticating');
});

test('a rejected session with no fallback account leaves the client signed out', async () => {
  const restore: { session: SessionInfo | null } = { session };
  const accounts = { accounts: [session] };
  const fake = fakeTransport({ restore, list_accounts: accounts });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  accounts.accounts.length = 0;
  restore.session = null;
  fake.emit({ type: 'session_ended', reason: 'token_rejected' });

  await vi.waitFor(() => {
    expect(core.status).toBe('signed-out');
    expect(core.session).toBeNull();
  });
  expect(fake.sent).not.toContainEqual({ type: 'logout' });
});

test('soft logout retains the account to reauthenticate', async () => {
  const accounts = { accounts: [session] };
  const fake = fakeTransport({ restore: { session }, list_accounts: accounts });
  const core = createCoreClient(() => fake.transport);
  await core.start();
  accounts.accounts = [{ ...session, needs_reauth: true }];
  fake.emit({ type: 'session_ended', reason: 'soft_logout' });
  await vi.waitFor(() => {
    expect(core.status).toBe('signed-out');
  });
  expect(core.reauthenticationAccountId).toBe(session.account_id);
  expect(core.session).toBeNull();
});

test('a transient sync error keeps the current session ready', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  fake.emit({ type: 'sync_status', state: 'error', message: 'temporary sync failure' });

  expect(core.status).toBe('ready');
  expect(core.session).toEqual(session);
  expect(core.sync).toEqual({
    type: 'sync_status',
    state: 'error',
    message: 'temporary sync failure',
  });
});

test('failed profile lookups cool down across repeated timeline mounts and retry later', async () => {
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  const failure = new Error('profile unavailable');
  const send = fake.send;
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  send.mockRejectedValue(failure);
  try {
    await expect(core.userProfile('@remote:example.org')).rejects.toBe(failure);
    await expect(core.userProfile('@remote:example.org')).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);

    now.mockReturnValue(61_001);
    await expect(core.userProfile('@remote:example.org')).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
    core.stop();
  }
});
