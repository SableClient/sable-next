import { afterEach, expect, test, vi } from 'vitest';

import { reportSessionFailure } from '#lib/observability/session-telemetry.js';

import type { AttachmentInfoView, CoreEvent, SessionInfo } from '#src/generated/protocol';
import { CoreError, type GalleryAttachment, type Transport } from '#src/transport';

import { recentSearches, rememberSearch } from '#lib/search/recent-searches.svelte.js';

import { joinRoom } from './api/rooms.js';
import { createCoreClient } from './client.svelte.js';
import * as attachmentInfo from './attachment-info.js';

vi.mock('#lib/observability/session-telemetry.js', () => ({ reportSessionFailure: vi.fn() }));

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

test('a locked account keeps its session and clears the lock after switching accounts', async () => {
  const fake = fakeTransport({
    'session.restore': session,
    'session.list_accounts': [session, otherSession],
    'session.switch_account': otherSession,
  });
  const core = createCoreClient(() => fake.transport);
  await core.start();
  fake.emit({ type: 'account_lock_changed', account_id: session.account_id, locked: true });
  expect(core.accountLocked).toBe(true);
  expect(core.session).toEqual(session);
  fake.emit({ type: 'account_lock_changed', account_id: session.account_id, locked: false });
  expect(core.accountLocked).toBe(false);
  fake.emit({ type: 'account_lock_changed', account_id: session.account_id, locked: true });
  await core.switchAccount(otherSession.account_id);
  expect(core.accountLocked).toBe(false);
  expect(core.session).toEqual(otherSession);
  expect(fake.deleteAccountStore).not.toHaveBeenCalled();
});

test('a restore that takes longer than fifteen seconds is reported as a slow start', async () => {
  vi.useFakeTimers();
  try {
    const fake = fakeTransport({ 'session.restore': () => new Promise(() => {}) });
    const core = createCoreClient(() => fake.transport);
    void core.start();

    await vi.advanceTimersByTimeAsync(14_999);
    expect(core.slowStart).toBe(false);
    expect(reportSessionFailure).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(core.slowStart).toBe(true);
    expect(core.status).toBe('starting');
    expect(reportSessionFailure).toHaveBeenCalledWith('restore_slow');
  } finally {
    vi.useRealTimers();
  }
});

test('a slow restore that finishes clears the slow start', async () => {
  vi.useFakeTimers();
  try {
    let finish: (value: SessionInfo) => void = () => {};
    const fake = fakeTransport({
      'session.restore': () => new Promise<SessionInfo>((resolve) => (finish = resolve)),
      'session.list_accounts': [session],
    });
    const core = createCoreClient(() => fake.transport);
    const started = core.start();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(core.slowStart).toBe(true);

    finish(session);
    await started;
    expect(core.status).toBe('ready');
    expect(core.slowStart).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('retrying a stuck start begins a new attempt instead of joining it', async () => {
  vi.useFakeTimers();
  try {
    let stuck = true;
    const fake = fakeTransport({
      'session.restore': () => (stuck ? new Promise(() => {}) : session),
      'session.list_accounts': [session],
    });
    const core = createCoreClient(() => fake.transport);
    void core.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(core.slowStart).toBe(true);

    stuck = false;
    await core.retryStart();

    expect(core.status).toBe('ready');
    expect(core.slowStart).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('keeps a lock event that arrives before the restored session response', async () => {
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
  const call = fake.call.getMockImplementation();
  if (!call) throw new Error('missing transport handler');
  fake.call.mockImplementation((method, params) => {
    if (method === 'session.restore')
      fake.emit({ type: 'account_lock_changed', account_id: session.account_id, locked: true });
    return call(method, params);
  });
  const core = createCoreClient(() => fake.transport);
  await core.start();
  expect(core.accountLocked).toBe(true);
  expect(core.session).toEqual(session);
});

function fakeTransport(responses: Record<string, unknown> = {}) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const storageFailureListeners = new Set<() => void>();
  const sent: { type: string }[] = [];
  const called: { method: string; params: unknown }[] = [];
  const close = vi.fn();
  const resetCaches = vi.fn().mockResolvedValue(undefined);
  const deleteAccountStore = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn((command: { type: string }) => {
    sent.push(command);
    return Promise.resolve(
      responses[command.type] ?? (command.type === 'list_accounts' ? { accounts: [] } : {})
    );
  });
  const call = vi.fn((method: string, params: unknown) => {
    called.push({ method, params });
    const response = responses[method];
    return Promise.resolve(
      typeof response === 'function'
        ? (response as () => unknown)()
        : (response ??
            (method === 'session.list_accounts'
              ? []
              : method === 'messages.media_config'
                ? { upload_size: 100 * 1024 * 1024 }
                : null))
    );
  });
  const transport = {
    call,
    send,
    resetCaches,
    deleteAccountStore,
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
    call,
    called,
    send,
    sent,
    close,
    resetCaches,
    deleteAccountStore,
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    },
    emitStorageFailure: () => {
      for (const listener of storageFailureListeners) listener();
    },
  };
}

test.each([false, true])(
  'GIF and location commands serialize silentReply=%s',
  async (silentReply) => {
    const fake = fakeTransport();
    const core = createCoreClient(() => fake.transport);
    await core.rpc.messages.sendGif({
      room_id: '!room:example.org',
      url: 'mxc://example.org/gif',
      body: 'cat.gif',
      width: null,
      height: null,
      mimetype: 'image/gif',
      size: null,
      in_reply_to: '$target',
      silent_reply: silentReply,
      thread_root: null,
      persona: null,
    });
    expect(fake.call).toHaveBeenLastCalledWith(
      'messages.send_gif',
      expect.objectContaining({ in_reply_to: '$target', silent_reply: silentReply })
    );
    await core.rpc.messages.sendLocation({
      room_id: '!room:example.org',
      body: 'here',
      geo_uri: 'geo:48,2',
      in_reply_to: '$target',
      silent_reply: silentReply,
      thread_root: null,
    });
    expect(fake.call).toHaveBeenLastCalledWith(
      'messages.send_location',
      expect.objectContaining({ in_reply_to: '$target', silent_reply: silentReply })
    );
  }
);

test('a restore that returns a session leaves the client ready', async () => {
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  expect(core.status).toBe('ready');
  expect(core.session?.user_id).toBe('@erwan:example.org');
  expect(core.accounts).toHaveLength(1);
});

test('an interrupted storage connection requires an explicit reload', async () => {
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  fake.emitStorageFailure();

  expect(core.storageInterrupted).toBe(true);
});

test('logging out selects another saved account instead of returning to sign-in', async () => {
  const accounts = { accounts: [session, otherSession] };
  const fake = fakeTransport({
    'session.restore': session,
    'session.list_accounts': () => accounts.accounts,
    'session.switch_account': otherSession,
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  accounts.accounts = [otherSession];

  await core.logout();

  expect(core.session).toEqual(otherSession);
  expect(core.accounts).toEqual([otherSession]);
  expect(core.status).toBe('ready');
  expect(fake.called).toContainEqual({
    method: 'session.switch_account',
    params: { account_id: otherSession.account_id },
  });
});

test("logging out forgets that account's recent searches and keeps the others'", async () => {
  const accounts = { accounts: [session, otherSession] };
  const fake = fakeTransport({
    'session.restore': session,
    'session.list_accounts': () => accounts.accounts,
    'session.switch_account': otherSession,
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
    'session.restore': session,
    'session.list_accounts': () => accounts.accounts,
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
  fake.transport.call = vi.fn(() => Promise.reject(new Error('worker gone')));
  const core = createCoreClient(() => fake.transport);
  rememberSearch(session.user_id, 'rollback plan');

  await core.start();

  expect(core.status).toBe('error');
  expect(recentSearches(session.user_id)).toContain('rollback plan');
});

test('a restore that returns no session reports signed out, not an error', async () => {
  const fake = fakeTransport({ 'session.restore': null });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  expect(core.status).toBe('signed-out');
  expect(core.session).toBeNull();
});

test('a failed restore can retry without logging in or deleting stores', async () => {
  const fake = fakeTransport();
  fake.transport.call = vi.fn(() => Promise.reject(new Error('worker gone')));
  const recovered = fakeTransport({
    'session.restore': session,
    'session.list_accounts': [session],
  });
  const open = vi.fn().mockReturnValueOnce(fake.transport).mockReturnValue(recovered.transport);
  const core = createCoreClient(open);

  await core.start();

  expect(core.status).toBe('error');
  expect(core.session).toBeNull();
  expect(fake.close).toHaveBeenCalledOnce();
  expect(fake.deleteAccountStore).not.toHaveBeenCalled();
  await core.start();
  expect(core.status).toBe('ready');
  expect(core.session?.device_id).toBe(session.device_id);
  expect(recovered.called.map((call) => call.method)).not.toContain('auth.login');
});

test('a restored session survives an account-list failure and a retry', async () => {
  const fake = fakeTransport({ 'session.restore': session });
  fake.call.mockImplementation((method) =>
    method === 'session.list_accounts'
      ? Promise.reject(new CoreError({ code: 'failed', log_id: 'e1' }))
      : Promise.resolve(session)
  );
  const recovered = fakeTransport({
    'session.restore': session,
    'session.list_accounts': [session],
  });
  const core = createCoreClient(
    vi.fn().mockReturnValueOnce(fake.transport).mockReturnValue(recovered.transport)
  );
  await core.start();
  expect(core.status).toBe('error');
  expect(core.session?.device_id).toBe(session.device_id);
  await core.start();
  expect(core.status).toBe('ready');
  expect(core.session?.device_id).toBe(session.device_id);
});

test.each(['list_accounts', 'switch_account'])(
  'retry resumes fallback selection after a failed %s',
  async (failedCommand) => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const retired = { ...session, needs_reauth: true };
    const initial = fakeTransport({
      'session.restore': session,
      'session.list_accounts': [session, otherSession],
    });
    const retry = fakeTransport({
      'session.restore': null,
      'session.list_accounts': [retired, otherSession],
      'session.switch_account': otherSession,
    });
    const core = createCoreClient(
      vi.fn().mockReturnValueOnce(initial.transport).mockReturnValue(retry.transport)
    );
    await core.start();
    initial.call.mockImplementation((method) =>
      method === `session.${failedCommand}`
        ? Promise.reject(new CoreError({ code: 'failed', log_id: 'e1' }))
        : Promise.resolve([retired, otherSession])
    );
    initial.emit({ type: 'session_ended', reason: 'soft_logout' });
    await vi.waitFor(() => {
      expect(core.status).toBe('error');
    });
    await core.start();
    expect(core.status).toBe('ready');
    expect(core.session).toEqual(otherSession);
    expect(core.restoreFailed).toBe(false);
    expect(retry.called).toContainEqual({
      method: 'session.switch_account',
      params: { account_id: otherSession.account_id },
    });
  }
);

test('failed crypto restoration exposes saved accounts for deliberate recovery', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const fake = fakeTransport({ 'session.list_accounts': [session, otherSession] });
  fake.call.mockImplementation((method) =>
    method === 'session.restore'
      ? Promise.reject(new CoreError({ code: 'failed', log_id: 'e1' }))
      : Promise.resolve([session, otherSession])
  );
  const core = createCoreClient(() => fake.transport);
  await core.start();
  expect(core.restoreFailed).toBe(true);
  expect(core.accounts).toEqual([session, otherSession]);
});

test('fresh sign-in recovery keeps saved account data and avoids old-device reauthentication', async () => {
  vi.stubGlobal('BroadcastChannel', undefined);
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
  const core = createCoreClient(() => fake.transport);
  await core.start();
  core.restoreFailed = true;
  core.reauthenticationAccountId = session.account_id;
  core.beginSignInRecovery();
  expect(core.status).toBe('signed-out');
  expect(core.session).toBeNull();
  expect(core.restoreFailed).toBe(false);
  expect(core.reauthenticationAccountId).toBeNull();
  expect(core.accounts).toEqual([session]);
  expect(fake.called.map((call) => call.method)).not.toContain('session.logout');
  expect(fake.deleteAccountStore).not.toHaveBeenCalled();
  expect(fake.resetCaches).not.toHaveBeenCalled();
});

test.each(['password', 'oidc', 'sso', 'qr'])(
  '%s recovery selects the new device when the old account belongs to the same user',
  async (method) => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const fresh = { ...session, account_id: 'new-device', device_id: 'NEW' };
    const fake = fakeTransport({
      'session.restore': fresh,
      'session.list_accounts': [session, fresh],
      'auth.login': session.user_id,
      'auth.complete_oidc_login': session.user_id,
      'auth.complete_sso_login': session.user_id,
    });
    const core = createCoreClient(() => fake.transport);
    if (method === 'password') {
      await core.login(session.homeserver, { kind: 'user', user: session.user_id }, 'password');
    } else if (method === 'oidc') {
      await core.completeOidcLogin('sable://oauth/callback?code=new');
    } else if (method === 'sso') {
      await core.completeSsoLogin('sable://sso/callback?loginToken=new');
    } else {
      await core.finishQrLogin(session.user_id);
    }
    expect(core.session).toEqual(fresh);
    expect(core.status).toBe('ready');
    expect(core.accounts).toEqual([session, fresh]);
    expect(fake.deleteAccountStore).not.toHaveBeenCalled();
    core.stop();
  }
);

test('concurrent starts share one restore', async () => {
  const fake = fakeTransport({ 'session.restore': null });
  const core = createCoreClient(() => fake.transport);

  await Promise.all([core.start(), core.start(), core.start()]);

  expect(fake.called.filter((call) => call.method === 'session.restore')).toHaveLength(1);
});

test('calls dispatch through the transport the client was given', async () => {
  const fake = fakeTransport({ 'session.restore': null, 'rooms.aliases': ['#a:b'] });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  await expect(core.rpc.rooms.aliases({ room_id: '!room:example.org' })).resolves.toEqual(['#a:b']);
  expect(fake.called).toContainEqual({
    method: 'rooms.aliases',
    params: { room_id: '!room:example.org' },
  });
});

test('joining copies caller-provided arrays, so reactive proxies cannot reach the transport', async () => {
  const fake = fakeTransport({ 'session.restore': null, 'rooms.join': '!x:b' });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  // Any Proxy stands in for a `$state` array, which structured clone refuses.
  const via = new Proxy(['example.org'], {});
  await joinRoom(core.rpc, '!room:example.org', via);

  const call = fake.called.find((entry) => entry.method === 'rooms.join');
  expect(call?.params).toEqual({ address: '!room:example.org', via: ['example.org'] });
  expect(() => structuredClone(call?.params)).not.toThrow();
});

test.each(['attachment', 'gallery', 'scheduled'] as const)(
  '%s uploads use the server limit instead of 100 MiB',
  async (kind) => {
    const fake = fakeTransport({
      'messages.media_config': { upload_size: 500 * 1024 * 1024 },
      'session.delayed_events_supported': true,
      'messages.schedule_attachment': 'delayed',
    });
    fake.transport.sendGallery = vi.fn();
    const core = createCoreClient(() => fake.transport);
    const file = new File(['x'], 'large.bin', { type: 'application/octet-stream' });
    Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024 });

    if (kind === 'attachment') await core.media.sendAttachment('!room:example.org', file);
    if (kind === 'gallery') await core.media.sendGallery('!room:example.org', [file, file]);
    if (kind === 'scheduled')
      await core.media.scheduleAttachment('!room:example.org', file, Date.now() + 30_000);

    expect(fake.called).toContainEqual({ method: 'messages.media_config', params: {} });
  }
);

test.each(['attachment', 'gallery', 'scheduled'] as const)(
  '%s uploads reject files above a smaller server limit before reading them',
  async (kind) => {
    const fake = fakeTransport({ 'messages.media_config': { upload_size: 10_000_000 } });
    const sendAttachment = vi.spyOn(fake.transport, 'sendAttachment');
    const uploadMedia = vi.spyOn(fake.transport, 'uploadMedia');
    const sendGallery = vi.fn<Transport['sendGallery']>();
    fake.transport.sendGallery = sendGallery;
    const core = createCoreClient(() => fake.transport);
    const file = new File(['x'], 'large.bin', { type: 'application/octet-stream' });
    Object.defineProperty(file, 'size', { value: 10_000_001 });
    const read = vi.spyOn(file, 'arrayBuffer');

    const sending =
      kind === 'attachment'
        ? core.media.sendAttachment('!room:example.org', file)
        : kind === 'gallery'
          ? core.media.sendGallery('!room:example.org', [file, file])
          : core.media.scheduleAttachment('!room:example.org', file, Date.now() + 30_000);

    await expect(sending).rejects.toThrow('10 MB');
    expect(read).not.toHaveBeenCalled();
    expect(sendAttachment).not.toHaveBeenCalled();
    expect(sendGallery).not.toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
  }
);

test('sending a voice recording forwards its MIME type, duration, waveform and voice marker', async () => {
  const fake = fakeTransport();
  const sendAttachment = vi.fn<Transport['sendAttachment']>();
  fake.transport.sendAttachment = sendAttachment;
  const core = createCoreClient(() => fake.transport);
  const recording = new File(['recording'], 'voice.ogg', { type: 'audio/ogg' });
  attachmentInfo.markVoiceRecording(recording, [0, 0.5, 1], 1250);

  await core.media.sendAttachment('!room:example.org', recording);

  expect(sendAttachment).toHaveBeenCalledOnce();
  expect(sendAttachment.mock.calls[0][0]).toMatchObject({
    filename: 'voice.ogg',
    mime: 'audio/ogg',
    info: { voice: true, duration_ms: 1250, waveform: [0, 0.5, 1] },
  });
});

test('sending an attachment forwards its rich caption, mentions, reply, and thread', async () => {
  const fake = fakeTransport();
  const sendAttachment = vi.fn<Transport['sendAttachment']>();
  fake.transport.sendAttachment = sendAttachment;
  const core = createCoreClient(() => fake.transport);
  const file = new File(['pdf'], 'report.pdf', { type: 'application/pdf' });

  await core.media.sendAttachment('!room:example.org', file, {
    caption: 'hey Member One :wave:',
    formattedCaption:
      'hey <a href="https://matrix.to/#/@one:example.org">Member One</a> <img data-mx-emoticon>',
    mentions: { user_ids: ['@one:example.org'], room: true },
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
    thumbnail: null,
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

test.each(['attachment', 'gallery'] as const)(
  'sending a video %s separates its thumbnail from metadata',
  async (kind) => {
    const info: AttachmentInfoView = {
      width: 1920,
      height: 1080,
      duration_ms: 12000,
      animated: null,
      blurhash: null,
      waveform: null,
      voice: false,
      audio_metadata: null,
    };
    const thumbnail = { bytes: new Uint8Array([255, 216, 255]), width: 800, height: 450 };
    const measure = vi
      .spyOn(attachmentInfo, 'measureAttachment')
      .mockResolvedValue({ info, thumbnail });
    try {
      const fake = fakeTransport();
      const sent: GalleryAttachment[] = [];
      fake.transport.sendAttachment = (attachment) => {
        sent.push(attachment);
        return Promise.resolve();
      };
      fake.transport.sendGallery = (gallery) => {
        sent.push(...gallery.attachments);
        return Promise.resolve();
      };
      const core = createCoreClient(() => fake.transport);
      const file = new File(['video'], 'video.mp4', { type: 'video/mp4' });
      if (kind === 'attachment') await core.media.sendAttachment('!room:example.org', file);
      else await core.media.sendGallery('!room:example.org', [file, file]);
      expect(sent).toHaveLength(kind === 'attachment' ? 1 : 2);
      for (const attachment of sent) {
        expect(attachment.info).toEqual(info);
        expect(attachment.thumbnail).toBe(thumbnail);
        expect(attachment.bytes).toEqual(new TextEncoder().encode('video'));
      }
    } finally {
      measure.mockRestore();
    }
  }
);

test('scheduling an attachment uploads it before creating its delayed event', async () => {
  const fake = fakeTransport({
    'session.delayed_events_supported': true,
    'messages.schedule_attachment': 'delayed-image',
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

  await expect(core.media.scheduleAttachment('!room:example.org', file, 40_000)).resolves.toBe(
    'delayed-image'
  );
  vi.useRealTimers();

  expect(uploadMedia).toHaveBeenCalledWith('image/png', new TextEncoder().encode('image'));
  expect(fake.called).toContainEqual({
    method: 'messages.schedule_attachment',
    params: {
      room_id: '!room:example.org',
      filename: 'later.png',
      mime: 'image/png',
      url: 'mxc://example.org/later',
      size: 5,
      info: null,
      spoiler: false,
      persona: null,
      delay_ms: 28_000,
    },
  });
});

test('an attachment is not uploaded when the homeserver cannot schedule it', async () => {
  const fake = fakeTransport({ 'session.delayed_events_supported': false });
  const uploadMedia = vi.fn(() => Promise.resolve('mxc://example.org/never'));
  fake.transport.uploadMedia = uploadMedia;
  const core = createCoreClient(() => fake.transport);
  const file = new File(['image'], 'later.png', { type: 'image/png' });

  await expect(
    core.media.scheduleAttachment('!room:example.org', file, Date.now() + 30_000)
  ).rejects.toMatchObject({ detail: { code: 'delayed_events_unsupported' } });

  expect(uploadMedia).not.toHaveBeenCalled();
  expect(fake.called.map((call) => call.method)).not.toContain('messages.schedule_attachment');
});

test('sending a gallery forwards shared metadata and every attachment', async () => {
  const persona = {
    id: 'kris',
    display_name: 'Kris',
    avatar_url: null,
    pronouns: [],
    color_on_light: null,
    color_on_dark: null,
    has_fallback: false,
  };
  const fake = fakeTransport();
  const sendGallery = vi.fn<Transport['sendGallery']>();
  fake.transport.sendGallery = sendGallery;
  const core = createCoreClient(() => fake.transport);
  const first = new File(['one'], 'one.png', { type: 'image/png' });
  const second = new File(['two'], 'two.pdf', { type: 'application/pdf' });

  await core.media.sendGallery('!room:example.org', [first, second], {
    caption: 'Weekend',
    formattedCaption: '<strong>Weekend</strong>',
    mentions: { user_ids: ['@one:example.org'], room: true },
    inReplyTo: '$reply',
    threadRoot: '$thread',
    persona,
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
    persona,
  });
});

test('stopping clears the session and closes the transport', async () => {
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  core.stop();

  expect(core.status).toBe('idle');
  expect(core.session).toBeNull();
  expect(fake.close).toHaveBeenCalled();
});

test('core events from the transport reach client state', async () => {
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
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
    'session.restore': session,
    'session.list_accounts': [session],
    'session.sync_status': { state: 'live' },
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  await vi.waitFor(() => {
    expect(core.sync?.state).toBe('live');
  });
});

test('a restored session loads its own profile so a first send has colors and pronouns', async () => {
  const own = { display_name: 'me', pronouns: [{ summary: 'they/them', language: null }] };
  const fake = fakeTransport({
    'session.restore': session,
    'session.list_accounts': [session],
    'account.user_profile': own,
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();

  await vi.waitFor(() => {
    expect(core.cachedUserProfile(session.user_id)).toEqual(own);
  });
  expect(fake.called).toContainEqual({
    method: 'account.user_profile',
    params: { user_id: session.user_id },
  });
});

test('a failed own-profile load does not block the first timeline lookup', async () => {
  const fake = fakeTransport({
    'session.restore': session,
    'session.list_accounts': [session],
  });
  const core = createCoreClient(() => fake.transport);
  fake.call.mockImplementation((method: string, params: unknown) => {
    fake.called.push({ method, params });
    if (method === 'account.user_profile') return Promise.reject(new Error('offline'));
    return Promise.resolve(method === 'session.list_accounts' ? [session] : session);
  });

  await core.start();
  await vi.waitFor(() => {
    expect(fake.called.some((call) => call.method === 'account.user_profile')).toBe(true);
  });
  await Promise.resolve();

  const next = { display_name: 'me' };
  fake.call.mockResolvedValue(next);
  await expect(core.userProfile(session.user_id)).resolves.toEqual(next);
});

async function startGated(fetch: () => Promise<unknown>) {
  localNetwork.gated = true;
  const fetchMock = vi.fn(fetch);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('navigator', { onLine: true });
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
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
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
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
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
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
  expect(fake.called).toContainEqual({
    method: 'encryption.accept_verification',
    params: { user_id: session.user_id, flow_id: 'incoming-flow' },
  });
  expect(fake.called.some((call) => call.method === 'encryption.request_verification')).toBe(false);
  unsubscribe();
});

test('an incoming verification from another user opens a flow for that user', async () => {
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
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
  expect(fake.called).toContainEqual({
    method: 'encryption.accept_verification',
    params: { user_id: '@alice:example.org', flow_id: 'alice-flow' },
  });
  expect(fake.called.some((call) => call.method === 'encryption.request_verification')).toBe(false);
  unsubscribe();
});

test('a session ending clears the session and looks for a fallback account', async () => {
  const fake = fakeTransport({
    'session.restore': session,
    'session.list_accounts': [session],
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
  const fake = fakeTransport({
    'session.restore': () => restore.session,
    'session.list_accounts': () => accounts.accounts,
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  accounts.accounts.length = 0;
  restore.session = null;
  fake.emit({ type: 'session_ended', reason: 'token_rejected' });

  await vi.waitFor(() => {
    expect(core.status).toBe('signed-out');
    expect(core.session).toBeNull();
  });
  expect(fake.called.map((call) => call.method)).not.toContain('session.logout');
});

test('soft logout retains the account to reauthenticate', async () => {
  const accounts = { accounts: [session] };
  const fake = fakeTransport({
    'session.restore': session,
    'session.list_accounts': () => accounts.accounts,
  });
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
  const fake = fakeTransport({
    'session.restore': session,
    'session.list_accounts': () => accounts.accounts,
  });
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
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
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
  const send = fake.call;
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

test('a profile change drops the cached profile and tells listeners once', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  fake.call
    .mockResolvedValueOnce({ display_name: 'old' })
    .mockResolvedValueOnce({ display_name: 'new' });
  const listener = vi.fn();
  try {
    core.onProfileChanged(listener);
    await core.userProfile('@remote:example.org');
    await core.userProfile('@remote:example.org');
    expect(fake.call).toHaveBeenCalledTimes(1);

    const change: CoreEvent = {
      type: 'profile_changed',
      room_id: '!room:example.org',
      user_id: '@remote:example.org',
      display_name: null,
      avatar_url: null,
    };
    fake.emit(change);
    fake.emit(change);
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).toHaveBeenCalledExactlyOnceWith('@remote:example.org');

    await expect(core.userProfile('@remote:example.org')).resolves.toEqual({
      display_name: 'new',
    });
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('expired profiles remain available for display while a fresh lookup is pending', async () => {
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  const cached = {
    display_name: 'old',
    name_color_dark: '#88aacc',
    pronouns: [{ summary: 'they/them', language: null }],
  };
  const refresh = Promise.withResolvers<unknown>();
  fake.call.mockResolvedValueOnce(cached).mockReturnValueOnce(refresh.promise);
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await core.userProfile('@remote:example.org');
    expect(core.cachedUserProfile('@remote:example.org')).toEqual(cached);
    now.mockReturnValue(121_001);
    expect(core.cachedUserProfile('@remote:example.org')).toBeNull();
    expect(core.cachedUserProfile('@remote:example.org', true)).toEqual(cached);

    const lookup = core.userProfile('@remote:example.org');
    expect(fake.call).toHaveBeenCalledTimes(2);
    expect(core.cachedUserProfile('@remote:example.org', true)).toEqual(cached);
    const fresh = { ...cached, display_name: 'new', pronouns: [] };
    refresh.resolve(fresh);
    await expect(lookup).resolves.toEqual(fresh);
    expect(core.cachedUserProfile('@remote:example.org')).toEqual(fresh);

    fake.emit({
      type: 'profile_changed',
      room_id: '!room:example.org',
      user_id: '@remote:example.org',
      display_name: null,
      avatar_url: null,
    });
    expect(core.cachedUserProfile('@remote:example.org', true)).toBeNull();
  } finally {
    now.mockRestore();
    core.stop();
  }
});

test('a lookup in flight when the profile changes does not refill the cache', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  fake.call
    .mockResolvedValueOnce({ display_name: 'stale' })
    .mockResolvedValueOnce({ display_name: 'fresh' });
  try {
    const stale = core.userProfile('@remote:example.org');
    fake.emit({
      type: 'profile_changed',
      room_id: '!room:example.org',
      user_id: '@remote:example.org',
      display_name: null,
      avatar_url: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    await stale;
    const fresh = core.userProfile('@remote:example.org');
    await vi.advanceTimersByTimeAsync(150);
    await expect(fresh).resolves.toEqual({ display_name: 'fresh' });
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('profile lookups run a bounded number at a time', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  const release: (() => void)[] = [];
  fake.call.mockImplementation(
    () =>
      new Promise((resolve) => {
        release.push(() => {
          resolve({});
        });
      })
  );
  try {
    const lookups = Array.from({ length: 26 }, (_, index) =>
      core.userProfile(`@user${index}:example.org`)
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.call).toHaveBeenCalledTimes(24);
    for (const resolve of release.splice(0)) resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.call).toHaveBeenCalledTimes(26);
    for (const resolve of release.splice(0)) resolve();
    await Promise.all(lookups);
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('the newest queued profile lookup runs first', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  const release: (() => void)[] = [];
  fake.call.mockImplementation(
    () =>
      new Promise((resolve) => {
        release.push(() => {
          resolve({});
        });
      })
  );
  try {
    for (let index = 0; index < 24; index += 1) void core.userProfile(`@old${index}:example.org`);
    void core.userProfile('@older:example.org');
    void core.userProfile('@newest:example.org');
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.call).toHaveBeenCalledTimes(24);
    release.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.call).toHaveBeenCalledTimes(25);
    expect(fake.call.mock.calls[24]?.[1]).toMatchObject({ user_id: '@newest:example.org' });
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('a cancelled queued profile lookup is never sent', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  const release: (() => void)[] = [];
  fake.call.mockImplementation(
    () =>
      new Promise((resolve) => {
        release.push(() => {
          resolve({});
        });
      })
  );
  try {
    for (let index = 0; index < 24; index += 1) void core.userProfile(`@busy${index}:example.org`);
    const cancelled = new AbortController();
    const kept = new AbortController();
    const first = core.userProfile('@shared:example.org', false, cancelled.signal);
    const second = core.userProfile('@shared:example.org', false, kept.signal);
    const alone = new AbortController();
    const lonely = core.userProfile('@alone:example.org', false, alone.signal);
    await vi.advanceTimersByTimeAsync(0);
    cancelled.abort();
    alone.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(lonely).rejects.toMatchObject({ name: 'AbortError' });
    for (const resolve of release.splice(0)) resolve();
    await vi.advanceTimersByTimeAsync(0);
    const requested = fake.call.mock.calls.map(
      ([, params]) => (params as { user_id: string }).user_id
    );
    expect(requested).toContain('@shared:example.org');
    expect(requested).not.toContain('@alone:example.org');
    for (const resolve of release.splice(0)) resolve();
    await expect(second).resolves.toEqual({});
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('an urgent profile lookup skips the queue', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  fake.call.mockImplementation(() => new Promise(() => {}));
  try {
    for (let index = 0; index < 26; index += 1) void core.userProfile(`@user${index}:example.org`);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.call).toHaveBeenCalledTimes(24);
    void core.userProfile('@card:example.org', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.call).toHaveBeenCalledTimes(25);
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('a rate-limited profile lookup waits out the hint and retries', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  fake.call
    .mockRejectedValueOnce(new CoreError({ code: 'rate_limited', retry_after_ms: 1000 }))
    .mockResolvedValueOnce({ user_id: '@remote:example.org' });
  try {
    const lookup = core.userProfile('@remote:example.org');
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(lookup).resolves.toEqual({ user_id: '@remote:example.org' });
    expect(fake.call).toHaveBeenCalledTimes(2);
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('a profile lookup that stayed rate limited is not remembered as failed', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  const limited = new CoreError({ code: 'rate_limited', retry_after_ms: 1000 });
  fake.call
    .mockRejectedValueOnce(limited)
    .mockRejectedValueOnce(limited)
    .mockResolvedValueOnce({ user_id: '@remote:example.org' });
  try {
    const first = core.userProfile('@remote:example.org');
    const failed = expect(first).rejects.toBe(limited);
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    await expect(core.userProfile('@remote:example.org')).resolves.toEqual({
      user_id: '@remote:example.org',
    });
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('a rate limit without a hint pauses every lookup for a second', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  fake.call
    .mockRejectedValueOnce(new CoreError({ code: 'rate_limited', retry_after_ms: null }))
    .mockResolvedValue({});
  try {
    const first = core.userProfile('@a:example.org');
    await vi.advanceTimersByTimeAsync(0);
    const second = core.userProfile('@b:example.org');
    await vi.advanceTimersByTimeAsync(999);
    expect(fake.call).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);
    expect(fake.call).toHaveBeenCalledTimes(3);
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('a rate-limit hint longer than 30s is capped', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  fake.call
    .mockRejectedValueOnce(new CoreError({ code: 'rate_limited', retry_after_ms: 3_600_000 }))
    .mockResolvedValueOnce({});
  try {
    const lookup = core.userProfile('@remote:example.org');
    await vi.advanceTimersByTimeAsync(30_000);
    await lookup;
    expect(fake.call).toHaveBeenCalledTimes(2);
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});

test('a sign-in the core cannot reach but the page can blames the local network', async () => {
  localNetwork.gated = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response('{}')))
  );
  const fake = fakeTransport();
  fake.call.mockImplementation((method: string) =>
    method === 'auth.login_flows'
      ? Promise.reject(new CoreError({ code: 'unavailable' }))
      : Promise.resolve(null)
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
  fake.call.mockImplementation(() => Promise.reject(new CoreError({ code: 'unavailable' })));
  const core = createCoreClient(() => fake.transport);

  await expect(core.loginFlows('https://matrix.lan')).rejects.toBeInstanceOf(CoreError);
});

test('an onion homeserver leaves discovery to the Matrix core without a browser fetch', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  const fake = fakeTransport({
    'auth.login_flows': {
      password: true,
      oidc: false,
      oidc_registration: false,
      qr_login: false,
      sso: false,
      oauth_aware_preferred: false,
      sso_identity_providers: [],
    },
  });
  const core = createCoreClient(() => fake.transport);
  const homeserver = 'http://exampleonionaddress.onion';

  await core.loginFlows(homeserver);

  expect(fetchMock).not.toHaveBeenCalled();
  expect(fake.called).toContainEqual({ method: 'auth.login_flows', params: { homeserver } });
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
    'session.restore': session,
    'session.list_accounts': [session],
    'encryption.devices': { devices: [device] },
  });
  const plain = fake.call.getMockImplementation();
  fake.call.mockImplementation((method: string, params: unknown) =>
    method === 'encryption.status'
      ? new Promise<object>((resolve) => {
          answer = resolve;
        })
      : (plain?.(method, params) ?? Promise.resolve(null))
  );
  const core = createCoreClient(() => fake.transport);

  await core.start();
  fake.emit({ type: 'encryption_status', status: known } as unknown as CoreEvent);
  answer(unknown);
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
    'session.restore': session,
    'session.list_accounts': [session],
    'encryption.devices': { devices: [device] },
  });
  const plain = fake.call.getMockImplementation();
  fake.call.mockImplementation((method: string, params: unknown) => {
    if (method === 'encryption.status')
      return new Promise<object>((resolve) => {
        answer = resolve;
      });
    if (method === 'auth.complete_oidc_login')
      return Promise.reject(new CoreError({ code: 'unavailable' }));
    return plain?.(method, params) ?? Promise.resolve(null);
  });
  const core = createCoreClient(() => fake.transport);

  await core.start();
  await expect(core.completeOidcLogin('sable://oauth/callback?code=used')).rejects.toBeInstanceOf(
    CoreError
  );
  answer(known);
  await vi.waitFor(() => {
    expect(core.encryption).toEqual(known);
  });

  expect(core.deviceList).toEqual([device]);
  expect(core.status).toBe('ready');
  core.stop();
});

test('refreshing a profile skips the cached copy and refills it', async () => {
  const fake = fakeTransport();
  const core = createCoreClient(() => fake.transport);
  fake.call
    .mockResolvedValueOnce({ display_name: 'stale' })
    .mockResolvedValueOnce({ display_name: 'live' });
  try {
    await core.userProfile('@remote:example.org');
    await expect(core.refreshUserProfile('@remote:example.org')).resolves.toEqual({
      display_name: 'live',
    });
    await expect(core.userProfile('@remote:example.org')).resolves.toEqual({
      display_name: 'live',
    });
    expect(fake.call).toHaveBeenCalledTimes(2);
  } finally {
    core.stop();
  }
});

test('writing a profile field invalidates the cached profile', async () => {
  vi.useFakeTimers();
  const fake = fakeTransport({ 'session.restore': session, 'session.list_accounts': [session] });
  const core = createCoreClient(() => fake.transport);
  const listener = vi.fn();
  try {
    await core.start();
    core.onProfileChanged(listener);
    await core.userProfile(session.user_id);
    await core.setProfileField('displayname', 'new');
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).toHaveBeenCalledExactlyOnceWith(session.user_id);
    await core.userProfile(session.user_id);
    expect(fake.called.filter((call) => call.method === 'account.user_profile')).toHaveLength(2);
  } finally {
    core.stop();
    vi.useRealTimers();
  }
});
