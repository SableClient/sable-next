import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent, SessionInfo } from '#src/generated/protocol';
import type { Transport } from '#src/transport';

import { recentSearches, rememberSearch } from '#lib/features/search/recent-searches.svelte.js';

import { createCoreClient } from './client.svelte.js';

const localNetwork = vi.hoisted(() => ({ gated: false, denied: false }));

vi.mock('#lib/platform/local-network.js', () => ({
  browserGatesCoreNetwork: () => localNetwork.gated,
  localNetworkDenied: () => Promise.resolve(localNetwork.denied),
}));

const session: SessionInfo = {
  account_id: 'account-a',
  user_id: '@erwan:example.org',
  device_id: 'LAPTOP',
  homeserver: 'https://example.org',
  needs_reauth: false,
};

const otherSession: SessionInfo = {
  ...session,
  account_id: 'account-b',
  user_id: '@other:example.org',
  device_id: 'PHONE',
};

function fakeTransport(responses: Record<string, unknown> = {}) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const sent: { type: string }[] = [];
  const close = vi.fn();
  const resetCaches = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn((command: { type: string }) => {
    sent.push(command);
    return Promise.resolve(responses[command.type] ?? {});
  });
  const transport = {
    send,
    resetCaches,
    deleteAccountStore: vi.fn().mockResolvedValue(undefined),
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
    resetCaches,
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

test('resetting caches also drops the persisted room list snapshot', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => {
      stored.delete(key);
    },
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  });
  stored.set(`sable.room-list.${session.account_id}`, JSON.stringify([{ room_id: '!room' }]));

  try {
    await core.start();
    await core.resetCaches();

    expect(fake.resetCaches).toHaveBeenCalledWith([session.account_id]);
    expect(stored.get(`sable.room-list.${session.account_id}`)).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

test('logging out selects another saved account instead of returning to sign-in', async () => {
  const accounts = { accounts: [session, otherSession] };
  const fake = fakeTransport({
    restore: { session },
    list_accounts: accounts,
    logout: {},
    switch_account: { session: otherSession },
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  accounts.accounts = [otherSession];

  await core.logout();

  expect(core.session).toEqual(otherSession);
  expect(core.accounts).toEqual([otherSession]);
  expect(core.status).toBe('ready');
  expect(fake.sent).toContainEqual({ type: 'switch_account', account_id: otherSession.account_id });
});

test("logging out forgets that account's recent searches and keeps the others'", async () => {
  const accounts = { accounts: [session, otherSession] };
  const fake = fakeTransport({
    restore: { session },
    list_accounts: accounts,
    logout: {},
    switch_account: { session: otherSession },
  });
  const core = createCoreClient(() => fake.transport);
  rememberSearch(session.user_id, 'salary review');
  rememberSearch(otherSession.user_id, 'rollback plan');

  await core.start();
  accounts.accounts = [otherSession];
  await core.logout();

  expect(recentSearches(session.user_id)).toEqual([]);
  expect(recentSearches(otherSession.user_id)).toEqual(['rollback plan']);
});

test('removing an account forgets its recent searches', async () => {
  const accounts = { accounts: [session, otherSession] };
  const fake = fakeTransport({
    restore: { session },
    list_accounts: accounts,
    remove_account: {},
  });
  const core = createCoreClient(() => fake.transport);
  rememberSearch(otherSession.user_id, 'rollback plan');

  await core.start();
  accounts.accounts = [session];
  await core.removeAccount(otherSession.account_id);

  expect(recentSearches(otherSession.user_id)).toEqual([]);
});

test("a restore that fails keeps every account's recent searches", async () => {
  const fake = fakeTransport();
  fake.transport.send = vi.fn(() => Promise.reject(new Error('worker gone')));
  const core = createCoreClient(() => fake.transport);
  rememberSearch(session.user_id, 'rollback plan');

  await core.start();

  expect(core.status).toBe('signed-out');
  expect(recentSearches(session.user_id)).toContain('rollback plan');
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
    spoiler: false,
  });
});

test('sending a gallery forwards shared metadata and every attachment', async () => {
  const fake = fakeTransport();
  const sendGallery = vi.fn<Transport['sendGallery']>();
  fake.transport.sendGallery = sendGallery;
  const core = createCoreClient(() => fake.transport);
  const first = new File(['one'], 'one.png', { type: 'image/png' });
  const second = new File(['two'], 'two.pdf', { type: 'application/pdf' });

  await core.commands.sendGallery('!room:example.org', [first, second], {
    caption: 'Weekend',
    formattedCaption: '<strong>Weekend</strong>',
    mentions: { userIds: ['@one:example.org'], room: true },
    inReplyTo: '$reply',
    threadRoot: '$thread',
  });

  expect(sendGallery).toHaveBeenCalledWith({
    roomId: '!room:example.org',
    attachments: [
      expect.objectContaining({ filename: 'one.png', mime: 'image/png' }),
      expect.objectContaining({ filename: 'two.pdf', mime: 'application/pdf' }),
    ],
    caption: 'Weekend',
    formattedCaption: '<strong>Weekend</strong>',
    mentions: ['@one:example.org'],
    mentionsRoom: true,
    inReplyTo: '$reply',
    threadRoot: '$thread',
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

async function startGated(fetch: () => Promise<unknown>) {
  localNetwork.gated = true;
  const fetchMock = vi.fn(fetch);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { onLine: true });
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);
  await core.start();
  return { core, fake, fetchMock };
}

afterEach(() => {
  localNetwork.gated = false;
  localNetwork.denied = false;
  vi.unstubAllGlobals();
});

test('a restored session asks for local network access from the page', async () => {
  const { fetchMock } = await startGated(() => Promise.resolve(new Response('{}')));

  expect(fetchMock).toHaveBeenCalledWith(new URL('https://example.org/_matrix/client/versions'), {
    mode: 'cors',
  });
});

test('an offline core with a homeserver the page reaches reports the browser blocking it', async () => {
  const { core, fake } = await startGated(() => Promise.resolve(new Response('{}')));

  fake.emit({ type: 'sync_status', state: 'offline' });
  await vi.waitFor(() => {
    expect(core.localNetworkBlocked).toBe('example.org');
  });

  fake.emit({ type: 'sync_status', state: 'live' });
  expect(core.localNetworkBlocked).toBeNull();
});

test('an offline core reports the browser blocking it when the permission was denied', async () => {
  localNetwork.denied = true;
  const { core, fake } = await startGated(() => Promise.reject(new TypeError('blocked')));

  fake.emit({ type: 'sync_status', state: 'offline' });

  await vi.waitFor(() => {
    expect(core.localNetworkBlocked).toBe('example.org');
  });
});

test('an offline core the page cannot reach either is just offline', async () => {
  const { core, fake, fetchMock } = await startGated(() =>
    Promise.reject(new TypeError('offline'))
  );

  fake.emit({ type: 'sync_status', state: 'offline' });
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(core.localNetworkBlocked).toBeNull();
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
  core.stop();
});

test('a rejected token retains the account to reauthenticate', async () => {
  const accounts = { accounts: [session] };
  const fake = fakeTransport({ restore: { session }, list_accounts: accounts });
  const core = createCoreClient(() => fake.transport);
  await core.start();
  accounts.accounts = [{ ...session, needs_reauth: true }];
  fake.emit({ type: 'session_ended', reason: 'token_rejected' });
  await vi.waitFor(() => {
    expect(core.status).toBe('signed-out');
  });
  expect(core.reauthenticationAccountId).toBe(session.account_id);
  expect(core.session).toBeNull();
  core.stop();
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
