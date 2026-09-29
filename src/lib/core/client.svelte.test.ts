import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent, SessionInfo } from '#src/generated/protocol';
import { CoreError, type Transport } from '#src/transport';

import { recentSearches, rememberSearch } from '#lib/features/search/recent-searches.svelte.js';

import { createCoreClient } from './client.svelte.js';

const localNetwork = vi.hoisted(() => ({ gated: false, denied: false }));

vi.mock('#lib/platform/local-network.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/local-network.js')>()),
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
  const storageFailureListeners = new Set<() => void>();
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
    subscribeStorageFailure: (listener: () => void) => {
      storageFailureListeners.add(listener);
      return () => storageFailureListeners.delete(listener);
    },
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
    emitStorageFailure: () => {
      for (const listener of storageFailureListeners) listener();
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

test('an interrupted storage connection requires an explicit reload', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  fake.emitStorageFailure();

  expect(core.storageInterrupted).toBe(true);
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

test('commands copy caller-provided arrays, so reactive proxies cannot reach the transport', async () => {
  const fake = fakeTransport({ restore: { session: null }, join_room: { room_id: '!x:b' } });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  // Any Proxy stands in for a `$state` array, which structured clone refuses.
  const via = new Proxy(['example.org'], {});
  await core.commands.joinRoom('!room:example.org', via);

  const sent = fake.sent.find((command) => command.type === 'join_room');
  expect(sent).toEqual({
    type: 'join_room',
    address: '!room:example.org',
    via: ['example.org'],
  });
  expect(() => structuredClone(sent)).not.toThrow();
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
    silentReply: false,
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

test('scheduling an attachment uploads it before creating its delayed event', async () => {
  const fake = fakeTransport({
    delayed_events_supported: { supported: true },
    schedule_attachment: { delay_id: 'delayed-image' },
  });
  const uploadMedia = vi.fn(() => {
    vi.setSystemTime(12_000);
    return Promise.resolve('mxc://example.org/later');
  });
  fake.transport.uploadMedia = uploadMedia;
  const core = createCoreClient(() => fake.transport);
  const file = new File(['image'], 'later.png', { type: 'image/png' });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(10_000);

  await expect(core.commands.scheduleAttachment('!room:example.org', file, 40_000)).resolves.toBe(
    'delayed-image'
  );
  vi.useRealTimers();

  expect(uploadMedia).toHaveBeenCalledWith('image/png', new TextEncoder().encode('image'));
  expect(fake.sent).toContainEqual({
    type: 'schedule_attachment',
    room_id: '!room:example.org',
    filename: 'later.png',
    mime: 'image/png',
    url: 'mxc://example.org/later',
    size: 5,
    info: null,
    spoiler: false,
    delay_ms: 28_000,
  });
});

test('an attachment is not uploaded when the homeserver cannot schedule it', async () => {
  const fake = fakeTransport({ delayed_events_supported: { supported: false } });
  const uploadMedia = vi.fn(() => Promise.resolve('mxc://example.org/never'));
  fake.transport.uploadMedia = uploadMedia;
  const core = createCoreClient(() => fake.transport);
  const file = new File(['image'], 'later.png', { type: 'image/png' });

  await expect(
    core.commands.scheduleAttachment('!room:example.org', file, Date.now() + 30_000)
  ).rejects.toMatchObject({ detail: { code: 'delayed_events_unsupported' } });

  expect(uploadMedia).not.toHaveBeenCalled();
  expect(fake.sent.map((command) => command.type)).not.toContain('schedule_attachment');
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
    silentReply: false,
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
    userId: session.user_id,
    flowId: 'active-flow',
    state: { phase: 'cancelled', reason: 'm.user' },
  });
  unsubscribe();
});

test('verifying while another device is asking accepts its request instead of crossing it', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  const unsubscribe = core.subscribeEvents(() => {});

  fake.emit({
    type: 'verification',
    user_id: session.user_id,
    flow_id: 'incoming-flow',
    state: { phase: 'requested', is_self: true, initiated_by_us: false },
  });

  await expect(core.requestVerification(session.user_id, 'NEWDEVICE')).resolves.toBe(
    'incoming-flow'
  );
  expect(fake.sent).toContainEqual({
    type: 'accept_verification',
    user_id: session.user_id,
    flow_id: 'incoming-flow',
  });
  expect(fake.sent.some((command) => command.type === 'request_verification')).toBe(false);
  unsubscribe();
});

test('an incoming verification from another user opens a flow for that user', async () => {
  const fake = fakeTransport({ restore: { session }, list_accounts: { accounts: [session] } });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  const unsubscribe = core.subscribeEvents(() => {});
  fake.emit({
    type: 'verification',
    user_id: '@alice:example.org',
    flow_id: 'alice-flow',
    state: { phase: 'requested', is_self: false, initiated_by_us: false },
  });

  expect(core.verification).toEqual({
    userId: '@alice:example.org',
    flowId: 'alice-flow',
    state: { phase: 'requested', is_self: false, initiated_by_us: false },
  });

  await expect(core.requestVerification('@alice:example.org')).resolves.toBe('alice-flow');
  expect(fake.sent).toContainEqual({
    type: 'accept_verification',
    user_id: '@alice:example.org',
    flow_id: 'alice-flow',
  });
  expect(fake.sent.some((command) => command.type === 'request_verification')).toBe(false);
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

test('a sign-in the core cannot reach but the page can blames the local network', async () => {
  localNetwork.gated = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{}')))
  );
  const fake = fakeTransport();
  fake.send.mockImplementation((command: { type: string }) =>
    command.type === 'login_flows'
      ? Promise.reject(new CoreError({ code: 'unavailable' }))
      : Promise.resolve({})
  );
  const core = createCoreClient(() => fake.transport);

  await expect(core.loginFlows('https://matrix.lan:8448')).rejects.toMatchObject({
    name: 'LocalNetworkBlockedError',
    host: 'matrix.lan',
  });
});

test('a sign-in the page cannot reach either stays unavailable', async () => {
  localNetwork.gated = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('offline')))
  );
  const fake = fakeTransport();
  fake.send.mockImplementation(() => Promise.reject(new CoreError({ code: 'unavailable' })));
  const core = createCoreClient(() => fake.transport);

  await expect(core.loginFlows('https://matrix.lan')).rejects.toBeInstanceOf(CoreError);
});

test('an onion homeserver leaves discovery to the Matrix core without a browser fetch', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const fake = fakeTransport({
    login_flows: {
      flows: {
        password: true,
        oidc: false,
        oidc_registration: false,
        sso: false,
        oauth_aware_preferred: false,
        sso_identity_providers: [],
      },
    },
  });
  const core = createCoreClient(() => fake.transport);
  const homeserver = 'http://exampleonionaddress.onion';

  await core.loginFlows(homeserver);

  expect(fetchMock).not.toHaveBeenCalled();
  expect(fake.sent).toContainEqual({ type: 'login_flows', homeserver });
});

test('a status reported while the first read is in flight is not overwritten by it', async () => {
  const unknown = {
    verification: 'unknown',
    recovery: 'unknown',
    cross_signing_ready: false,
    backup_unlocked: false,
    signing_keys: { master: false, self_signing: false, user_signing: false },
    recovery_passphrase: false,
  } as const;
  const known = { ...unknown, verification: 'verified', recovery: 'enabled' } as const;
  let answer: (value: object) => void = () => {};
  const device = { device_id: 'LAPTOP' };
  const fake = fakeTransport({
    restore: { session },
    list_accounts: { accounts: [session] },
    devices: { devices: [device] },
  });
  const plain = fake.send.getMockImplementation();
  fake.send.mockImplementation((command: { type: string }) =>
    command.type === 'encryption_status'
      ? new Promise<object>((resolve) => {
          answer = resolve;
        })
      : (plain?.(command) ?? Promise.resolve({}))
  );
  const core = createCoreClient(() => fake.transport);

  await core.start();
  fake.emit({ type: 'encryption_status', status: known } as unknown as CoreEvent);
  answer({ status: unknown });
  await vi.waitFor(() => {
    expect(core.deviceList).toEqual([device]);
  });

  expect(core.encryption).toEqual(known);
  core.stop();
});

test('a stale login callback that fails does not discard the first status read', async () => {
  const known = {
    verification: 'unverified',
    recovery: 'enabled',
    cross_signing_ready: true,
    backup_unlocked: false,
    signing_keys: { master: true, self_signing: true, user_signing: true },
    recovery_passphrase: false,
  } as const;
  let answer: (value: object) => void = () => {};
  const device = { device_id: 'LAPTOP' };
  const fake = fakeTransport({
    restore: { session },
    list_accounts: { accounts: [session] },
    devices: { devices: [device] },
  });
  const plain = fake.send.getMockImplementation();
  fake.send.mockImplementation((command: { type: string }) => {
    if (command.type === 'encryption_status')
      return new Promise<object>((resolve) => {
        answer = resolve;
      });
    if (command.type === 'complete_oidc_login')
      return Promise.reject(new CoreError({ code: 'unavailable' }));
    return plain?.(command) ?? Promise.resolve({});
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  await expect(core.completeOidcLogin('sable://oauth/callback?code=used')).rejects.toBeInstanceOf(
    CoreError
  );
  answer({ status: known });
  await vi.waitFor(() => {
    expect(core.encryption).toEqual(known);
  });

  expect(core.deviceList).toEqual([device]);
  expect(core.status).toBe('ready');
  core.stop();
});
