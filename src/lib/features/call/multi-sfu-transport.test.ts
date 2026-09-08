import { expect, test, vi } from 'vitest';

import type { LivekitTransport } from './livekit-transport';
import { createMultiSfuTransport } from './multi-sfu-transport';
import { idleTransportState, type CallTransportState } from './call-transport';

test('connects each backend while publishing media only on the publisher and routes tagged keys', async () => {
  const created: { publishMedia?: boolean; transport: ReturnType<typeof fakeTransport> }[] = [];
  const transport = createMultiSfuTransport(true, undefined, {
    createTransport: (options) => {
      const next = fakeTransport();
      created.push({ publishMedia: options.publishMedia, transport: next });
      return next;
    },
  });
  const backends = [
    { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' },
    { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'other' },
  ];
  await transport.connect({
    ...idleTransportState(),
    url: '',
    token: '',
    microphoneEnabled: true,
    cameraEnabled: true,
    publisherId: 'publish',
    backends,
    encryptionKeys: [{ backendId: 'publish', identity: 'me', keyIndex: 1, key: new Uint8Array() }],
  });
  expect(created.map((entry) => entry.publishMedia)).toEqual([true, false]);
  expect(created[0]?.transport.connect).toHaveBeenCalledWith(
    expect.objectContaining({ encryptionKeys: [expect.anything()] })
  );
  expect(created[1]?.transport.connect).toHaveBeenCalledWith(
    expect.objectContaining({ encryptionKeys: [] })
  );
  await transport.setEncryptionKey({ identity: 'x', keyIndex: 2, key: new Uint8Array() }, 'remote');
  expect(created[1].transport.setEncryptionKey).toHaveBeenCalledOnce();
});

test('starts the publisher and healthy subscribers while another subscriber is blocked', async () => {
  let releaseBlocked!: () => void;
  const blocked = new Promise<void>((resolve) => {
    releaseBlocked = resolve;
  });
  let subscribers = 0;
  const created: ReturnType<typeof fakeTransport>[] = [];
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: (options) => {
      const next = fakeTransport();
      if (options.publishMedia === false && subscribers++ === 0) {
        next.connect = vi.fn(() => blocked);
      }
      created.push(next);
      return next;
    },
  });
  let completed = false;
  const connecting = transport
    .connect({
      url: '',
      token: '',
      microphoneEnabled: false,
      cameraEnabled: false,
      publisherId: 'publish',
      backends: [
        { id: 'blocked', url: 'wss://blocked', jwt: 'blocked', identity: 'blocked' },
        { id: 'publish', url: 'wss://publish', jwt: 'publish', identity: 'me' },
        { id: 'healthy', url: 'wss://healthy', jwt: 'healthy', identity: 'healthy' },
      ],
      encryptionKeys: [],
    })
    .then(() => {
      completed = true;
    });

  await vi.waitFor(() => {
    expect(created).toHaveLength(3);
  });
  expect(created[0].getState().connection).toBe('connected');
  expect(created[2].getState().connection).toBe('connected');
  expect(completed).toBe(false);
  releaseBlocked();
  await connecting;
});

test('delivers a remote key while that subscriber is still connecting', async () => {
  let releaseRemote!: () => void;
  const remoteConnecting = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  const created: ReturnType<typeof fakeTransport>[] = [];
  const transport = createMultiSfuTransport(true, undefined, {
    createTransport: (options) => {
      const next = fakeTransport();
      if (options.publishMedia === false) next.connect = vi.fn(() => remoteConnecting);
      created.push(next);
      return next;
    },
  });
  const publisher = { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' };
  const remote = { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'other' };
  const connecting = transport.connect({
    url: '',
    token: '',
    microphoneEnabled: true,
    cameraEnabled: false,
    publisherId: publisher.id,
    backends: [publisher, remote],
    encryptionKeys: [],
  });
  await vi.waitFor(() => {
    expect(created).toHaveLength(2);
  });
  await transport.setEncryptionKey(
    { backendId: remote.id, identity: 'other', keyIndex: 1, key: new Uint8Array() },
    remote.id
  );
  expect(created[1].setEncryptionKey).toHaveBeenCalledOnce();
  releaseRemote();
  await connecting;
});

test('assigns an opaque backend id and role to each transport telemetry stream', async () => {
  const attributes: Record<string, string | number | boolean>[] = [];
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: (options) => {
      attributes.push(options.telemetryAttributes ?? {});
      return fakeTransport();
    },
  });
  await transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: 'publish',
    backends: [
      { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' },
      { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'other' },
    ],
    encryptionKeys: [],
  });
  expect(attributes).toEqual([
    { 'call.backend_id': 'publish', 'call.backend_role': 'publisher' },
    { 'call.backend_id': 'remote', 'call.backend_role': 'subscriber' },
  ]);
});

test('retries a failed subscriber on the next backend snapshot', async () => {
  let remoteAttempts = 0;
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: (options) => {
      const next = fakeTransport();
      if (options.publishMedia === false) {
        next.connect = vi.fn(() => {
          remoteAttempts += 1;
          return remoteAttempts === 1
            ? Promise.reject(new Error('OperationError'))
            : Promise.resolve();
        });
      }
      return next;
    },
  });
  const backends = [
    { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' },
    { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'other' },
  ];
  await transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: 'publish',
    backends,
    encryptionKeys: [],
  });
  await transport.reconcileBackends?.(backends);
  expect(remoteAttempts).toBe(2);
});

test('retains a backend key when a subscriber connect fails and retries', async () => {
  let remoteAttempts = 0;
  const created: ReturnType<typeof fakeTransport>[] = [];
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: (options) => {
      const next = fakeTransport();
      created.push(next);
      if (options.publishMedia === false) {
        next.connect = vi.fn(() => {
          remoteAttempts += 1;
          return remoteAttempts === 1
            ? Promise.reject(new Error('OperationError'))
            : Promise.resolve();
        });
      }
      return next;
    },
  });
  const publisher = { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' };
  const remote = { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'remote' };
  await transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: publisher.id,
    backends: [publisher],
    encryptionKeys: [],
  });
  await transport.setEncryptionKey({
    backendId: 'remote',
    identity: 'remote',
    keyIndex: 4,
    key: new Uint8Array(),
  });
  await transport.reconcileBackends?.([publisher, remote]);
  await transport.reconcileBackends?.([publisher, remote]);
  expect(created[2]?.connect).toHaveBeenCalledWith(
    expect.objectContaining({
      encryptionKeys: [expect.objectContaining({ backendId: 'remote', keyIndex: 4 })],
    })
  );
});

test('drops a deferred subscriber when a newer snapshot removes it', async () => {
  let resolveRemote!: () => void;
  const deferred = new Promise<void>((resolve) => {
    resolveRemote = resolve;
  });
  const created: ReturnType<typeof fakeTransport>[] = [];
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: (options) => {
      const next = fakeTransport();
      if (options.publishMedia === false) next.connect = vi.fn(() => deferred);
      created.push(next);
      return next;
    },
  });
  const publisher = { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' };
  const remote = { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'other' };
  await transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: publisher.id,
    backends: [publisher],
    encryptionKeys: [],
  });
  const adding = transport.reconcileBackends?.([publisher, remote]);
  await vi.waitFor(() => {
    expect(created).toHaveLength(2);
  });
  const removing = transport.reconcileBackends?.([publisher]);
  resolveRemote();
  await Promise.all([adding, removing]);
  expect(transport.rooms?.().map((entry) => entry.backendId)).toEqual(['publish']);
  expect(created[1].disconnect).toHaveBeenCalledOnce();
});

test('keeps a deferred publisher when a newer snapshot still desires it', async () => {
  let releasePublisher!: () => void;
  const publisherConnect = new Promise<void>((resolve) => {
    releasePublisher = resolve;
  });
  const created: ReturnType<typeof fakeTransport>[] = [];
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: (options) => {
      const next = fakeTransport();
      if (options.publishMedia) next.connect = vi.fn(() => publisherConnect);
      created.push(next);
      return next;
    },
  });
  const publisher = { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' };
  const first = transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: publisher.id,
    backends: [publisher],
    encryptionKeys: [],
  });
  await vi.waitFor(() => {
    expect(created).toHaveLength(1);
  });
  const newer = transport.reconcileBackends?.([publisher]);
  releasePublisher();
  await Promise.all([first, newer]);
  expect(transport.rooms?.().map((entry) => entry.backendId)).toEqual(['publish']);
  expect(created[0].disconnect).not.toHaveBeenCalled();
});

test('routes a tagged pending key only to its backend when that backend appears', async () => {
  let releaseRemote!: () => void;
  const remoteReady = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  const created: { id: string; transport: ReturnType<typeof fakeTransport> }[] = [];
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: (options) => {
      const next = fakeTransport();
      created.push({
        id: options.ownIdentity === 'remote' ? 'remote' : 'publish',
        transport: next,
      });
      if (options.ownIdentity === 'remote') next.connect = vi.fn(() => remoteReady);
      return next;
    },
  });
  const publisher = { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' };
  const remote = { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'remote' };
  await transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: publisher.id,
    backends: [publisher],
    encryptionKeys: [],
  });
  await transport.setEncryptionKey({
    backendId: 'remote',
    identity: 'r',
    keyIndex: 1,
    key: new Uint8Array(),
  });
  const adding = transport.reconcileBackends?.([publisher, remote]);
  await vi.waitFor(() => {
    expect(created).toHaveLength(2);
  });
  releaseRemote();
  await adding;
  expect(created[1].transport.connect).toHaveBeenCalledWith(
    expect.objectContaining({
      encryptionKeys: [expect.objectContaining({ backendId: 'remote', identity: 'r' })],
    })
  );
  expect(created[0].transport.connect).toHaveBeenCalledWith(
    expect.objectContaining({ encryptionKeys: [] })
  );
});

test('does not report connected when the publisher is absent', async () => {
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: () => fakeTransport(),
  });
  await expect(
    transport.connect({
      url: '',
      token: '',
      microphoneEnabled: false,
      cameraEnabled: false,
      publisherId: 'missing',
      backends: [{ id: 'remote', url: 'wss://two', jwt: 'two', identity: 'other' }],
      encryptionKeys: [],
    })
  ).rejects.toThrow('transport-not-connected');
  expect(transport.getState().connection).toBe('disconnected');
});

test('disposal prevents a pending add and later snapshot from creating a room', async () => {
  let releaseRemote!: () => void;
  const deferred = new Promise<void>((resolve) => {
    releaseRemote = resolve;
  });
  let created = 0;
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: (options) => {
      created += 1;
      const next = fakeTransport();
      if (!options.publishMedia) next.connect = vi.fn(() => deferred);
      return next;
    },
  });
  const publisher = { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' };
  const remote = { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'other' };
  await transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: publisher.id,
    backends: [publisher],
    encryptionKeys: [],
  });
  const adding = transport.reconcileBackends?.([publisher, remote]);
  await vi.waitFor(() => {
    expect(created).toBe(2);
  });
  const disconnecting = transport.disconnect();
  const later = transport.reconcileBackends?.([publisher, remote]);
  releaseRemote();
  await Promise.all([adding, disconnecting, later]);
  expect(transport.rooms?.()).toEqual([]);
  expect(created).toBe(2);
});

test('retries a disconnected subscriber with its cached key on the next snapshot', async () => {
  const created: ReturnType<typeof fakeTransport>[] = [];
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: () => {
      const next = fakeTransport();
      created.push(next);
      return next;
    },
  });
  const publisher = { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' };
  const remote = { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'remote' };
  await transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: publisher.id,
    backends: [publisher, remote],
    encryptionKeys: [],
  });
  await transport.setEncryptionKey(
    { backendId: remote.id, identity: remote.identity, keyIndex: 3, key: new Uint8Array() },
    remote.id
  );
  created[1].emitConnection('disconnected');
  await vi.waitFor(() => {
    expect(transport.rooms?.().map((entry) => entry.backendId)).toEqual(['publish']);
  });
  await transport.reconcileBackends?.([publisher, remote]);
  expect(created[2].connect).toHaveBeenCalledWith(
    expect.objectContaining({
      encryptionKeys: [expect.objectContaining({ identity: remote.identity, keyIndex: 3 })],
    })
  );
});

test('shutdown prevents a disconnected subscriber from being recreated', async () => {
  const created: ReturnType<typeof fakeTransport>[] = [];
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: () => {
      const next = fakeTransport();
      created.push(next);
      return next;
    },
  });
  const publisher = { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' };
  const remote = { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'remote' };
  await transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: publisher.id,
    backends: [publisher, remote],
    encryptionKeys: [],
  });
  created[1].emitConnection('disconnected');
  await transport.disconnect();
  await transport.reconcileBackends?.([publisher, remote]);
  await Promise.resolve();
  expect(transport.rooms?.()).toEqual([]);
  expect(created).toHaveLength(2);
});

test('does not discard a subscriber from its initial disconnected subscription state', async () => {
  const created: ReturnType<typeof fakeTransport>[] = [];
  const transport = createMultiSfuTransport(false, undefined, {
    createTransport: () => {
      const next = fakeTransport('disconnected');
      created.push(next);
      return next;
    },
  });
  const publisher = { id: 'publish', url: 'wss://one', jwt: 'one', identity: 'me' };
  const remote = { id: 'remote', url: 'wss://two', jwt: 'two', identity: 'remote' };
  await transport.connect({
    url: '',
    token: '',
    microphoneEnabled: false,
    cameraEnabled: false,
    publisherId: publisher.id,
    backends: [publisher, remote],
    encryptionKeys: [],
  });
  expect(transport.rooms?.().map((entry) => entry.backendId)).toEqual(['publish', 'remote']);
  expect(created[1].disconnect).not.toHaveBeenCalled();
});

function fakeTransport(initialConnection: CallTransportState['connection'] = 'connected') {
  const listeners = new Set<(state: CallTransportState) => void>();
  const state: CallTransportState = { ...idleTransportState(), connection: initialConnection };
  const emitConnection = (connection: CallTransportState['connection']): void => {
    state.connection = connection;
    for (const listener of listeners) listener(state);
  };
  return {
    room: {} as LivekitTransport['room'],
    keyProvider: undefined,
    connect: vi.fn(() => {
      emitConnection('connected');
      return Promise.resolve();
    }),
    disconnect: vi.fn(() => Promise.resolve()),
    setMicrophoneEnabled: vi.fn(() => Promise.resolve()),
    setCameraEnabled: vi.fn(() => Promise.resolve()),
    setEncryptionKey: vi.fn(() => Promise.resolve()),
    subscribe: vi.fn((listener: (state: ReturnType<typeof idleTransportState>) => void) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    }),
    getState: () => state,
    capabilities: { screenShare: { setEnabled: vi.fn(() => Promise.resolve()) } },
    emitConnection,
  };
}
