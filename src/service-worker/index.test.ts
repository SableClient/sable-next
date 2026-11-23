import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';

import { pushNotification } from '#lib/notifications/push-fixtures.js';

type PushEvent = { data: { text: () => string }; waitUntil: (pending: Promise<unknown>) => void };
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: PushEvent) => void>(),
  show: vi.fn().mockResolvedValue(undefined),
  notifications: vi.fn().mockResolvedValue([]),
  complete: vi.fn(),
  record: vi.fn().mockResolvedValue(undefined),
  location: { protocol: 'https:' },
  update: vi.fn(),
  watched: [] as Promise<unknown>[],
}));

vi.mock('$app/env', () => ({ version: 'test' }));
vi.mock('#lib/model/model.js', async (original) => ({
  ...(await original<object>()),
  loadModel: (source: () => Promise<Response>) => source().then(() => undefined),
}));
vi.mock('#lib/features/notifications/push-fetch.js', async (original) => ({
  ...(await original<object>()),
  completePushPayload: mocks.complete,
}));
vi.mock('./telemetry.js', async (original) => ({
  ...(await original<object>()),
  reportWorkerError: vi.fn(),
  watchWorkerOperation: (_operation: string, pending: Promise<unknown>) => {
    mocks.watched.push(pending);
    return pending;
  },
}));
vi.mock('#lib/notifications/room-names.js', () => ({
  currentServerUser: () => Promise.resolve(null),
  pushContentPolicy: () =>
    Promise.resolve({
      clearOnRead: true,
      content: true,
      encryptedContent: true,
      notifyOnce: false,
    }),
  pendingPushActivations: () => Promise.resolve([]),
  pushSession: () =>
    Promise.resolve({
      userId: '@me:example.org',
      deviceId: 'DEVICE',
      homeserver: 'https://example.org',
      accessToken: 'test',
    }),
  recordPush: mocks.record,
  roomMode: () => Promise.resolve(null),
  roomName: () => Promise.resolve('Room'),
  settlePushActivation: vi.fn(),
}));

beforeAll(async () => {
  vi.stubGlobal('self', {
    location: mocks.location,
    addEventListener: (type: string, handler: (event: PushEvent) => void) => {
      mocks.handlers.set(type, handler);
    },
    registration: {
      showNotification: mocks.show,
      getNotifications: mocks.notifications,
      update: mocks.update,
    },
    clients: { matchAll: () => Promise.resolve([]) },
  });
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('caches', { match: () => Promise.resolve(new Response()) });
  await import('./index');
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.location.protocol = 'https:';
  vi.stubGlobal('caches', { match: () => Promise.resolve(new Response()) });
});
afterAll(() => vi.unstubAllGlobals());

async function push(notification: unknown): Promise<void> {
  let pending: Promise<unknown> | undefined;
  mocks.handlers.get('push')?.({
    data: { text: () => JSON.stringify({ notification }) },
    waitUntil: (work) => {
      pending = work;
    },
  });
  await pending;
}

test('event-id-only call pushes with zero unread are fetched and posted', async () => {
  mocks.complete.mockResolvedValue(
    pushNotification({
      user_id: '@me:example.org',
      room_id: '!room:example.org',
      event_id: '$call',
      unread: 0,
      type: 'org.matrix.msc4075.rtc.notification',
      content: { notification_type: 'ring' },
    })
  );
  await push({
    user_id: '@me:example.org',
    room_id: '!room:example.org',
    event_id: '$call',
    counts: { unread: 0 },
  });
  expect(mocks.complete).toHaveBeenCalledOnce();
  expect(mocks.show.mock.calls[0]).toMatchObject([
    'Room',
    {
      tag: '@me:example.org !room:example.org:$call',
      data: { call: true, callEventId: '$call' },
    },
  ]);
});

test('count-only read pushes close messages and retain active call banners', async () => {
  const message = {
    data: { userId: '@me:example.org', roomId: '!room:example.org' },
    close: vi.fn(),
  };
  const call = {
    data: { ...message.data, call: true, callExpiresAtMs: Date.now() + 90000 },
    close: vi.fn(),
  };
  mocks.notifications.mockResolvedValue([message, call]);
  await push({ user_id: '@me:example.org', room_id: '!room:example.org', counts: { unread: 0 } });
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(message.close).toHaveBeenCalledOnce();
  expect(call.close).not.toHaveBeenCalled();
});

test('a push for an already shown event is skipped', async () => {
  const tag = '@me:example.org !room:example.org:$message';
  mocks.notifications.mockImplementation((filter?: { tag?: string }) =>
    Promise.resolve(filter?.tag === tag ? [{ tag, data: {} }] : [])
  );
  mocks.complete.mockResolvedValue(
    pushNotification({
      user_id: '@me:example.org',
      room_id: '!room:example.org',
      event_id: '$message',
      unread: 1,
      type: 'm.room.message',
      content: { body: 'hello' },
    })
  );
  await push({
    user_id: '@me:example.org',
    room_id: '!room:example.org',
    event_id: '$message',
    counts: { unread: 1 },
  });
  expect(mocks.show).not.toHaveBeenCalled();
  mocks.notifications.mockResolvedValue([]);
});

test('install refuses an HTML response in place of the model', async () => {
  const put = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('caches', { open: () => Promise.resolve({ put }) });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
      )
  );
  let pending: Promise<unknown> | undefined;
  mocks.handlers.get('install')?.({
    waitUntil: (work: Promise<unknown>) => {
      pending = work;
    },
  } as unknown as PushEvent);
  await expect(pending).rejects.toThrow('model wasm unavailable');
  expect(put).not.toHaveBeenCalled();
});

test('install caches the model on HTTPS', async () => {
  const response = new Response('wasm', { headers: { 'content-type': 'application/wasm' } });
  const put = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('caches', { open: () => Promise.resolve({ put }) });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  let pending: Promise<unknown> | undefined;
  mocks.handlers.get('install')?.({
    waitUntil: (work: Promise<unknown>) => {
      pending = work;
    },
  } as unknown as PushEvent);

  await pending;

  expect(put).toHaveBeenCalledWith(expect.any(String), response);
});

test('install skips the model cache on the desktop custom scheme', async () => {
  mocks.location.protocol = 'sable-app:';
  const open = vi.fn().mockRejectedValue(new Error('unsupported scheme'));
  let pending: Promise<unknown> | undefined;
  vi.stubGlobal('caches', { open });

  mocks.handlers.get('install')?.({
    waitUntil: (work: Promise<unknown>) => {
      pending = work;
    },
  } as unknown as PushEvent);
  await pending;

  expect(open).not.toHaveBeenCalled();
});

test('activation leaves the Cache API alone on the desktop custom scheme', async () => {
  mocks.location.protocol = 'sable-app:';
  const keys = vi.fn().mockRejectedValue(new Error('unsupported scheme'));
  let pending: Promise<unknown> | undefined;
  vi.stubGlobal('caches', { keys });

  mocks.handlers.get('activate')?.({
    waitUntil: (work: Promise<unknown>) => {
      pending = work;
    },
  } as unknown as PushEvent);
  await pending;

  expect(keys).not.toHaveBeenCalled();
});

test('pushes load the model without Cache API on the desktop custom scheme', async () => {
  mocks.location.protocol = 'sable-app:';
  const match = vi.fn().mockRejectedValue(new Error('unsupported scheme'));
  const open = vi.fn().mockRejectedValue(new Error('unsupported scheme'));
  const fetch = vi.fn().mockResolvedValue(new Response('wasm'));
  vi.stubGlobal('caches', { match, open });
  vi.stubGlobal('fetch', fetch);

  await push({ user_id: '@me:example.org', room_id: '!room:example.org', counts: { unread: 0 } });

  expect(fetch).toHaveBeenCalledOnce();
  expect(match).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});

const notFound = (): Response => new Response('Not found', { status: 404 });
const spaFallback = (): Response =>
  new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });

async function pushWithoutModel(answer: () => Response = notFound): Promise<unknown> {
  vi.stubGlobal('caches', { match: () => Promise.resolve(undefined) });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer()));
  mocks.watched.length = 0;
  await push({ user_id: '@me:example.org', room_id: '!room:example.org', counts: { unread: 1 } });
  expect(mocks.show).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ tag: 'sable-fallback' })
  );
  return mocks.watched[0]?.catch((error: unknown) => error);
}

test.each([
  ['a 404', notFound],
  ['the page of an SPA fallback', spaFallback],
])(
  'a worker whose removed model is answered with %s falls back as a replaced worker',
  async (_answer, answer) => {
    mocks.update.mockClear();
    mocks.update.mockResolvedValue({ installing: null, waiting: {} });
    const { StaleWorkerError } = await import('./telemetry.js');

    expect(await pushWithoutModel(answer)).toBeInstanceOf(StaleWorkerError);
    expect(mocks.update).toHaveBeenCalledOnce();
  }
);

test('a missing model with no newer worker to replace this one is still a failure', async () => {
  mocks.update.mockResolvedValue({ installing: null, waiting: null });
  const { ModelAssetError } = await import('#lib/model/model.js');

  expect(await pushWithoutModel()).toBeInstanceOf(ModelAssetError);
});
