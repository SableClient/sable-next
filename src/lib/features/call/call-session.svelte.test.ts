import { beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { CallSession } from './call-session.svelte.js';
import { MatrixKeyProvider } from './key-provider';
import type { CallTransportConnectOptions } from './call-transport';
import { resetCallOwner } from './call-owner';
import type { CallTransport, CallTransportState } from './call-transport';
import { idleTransportState } from './call-transport';

type Harness = {
  client: CoreClient;
  emit: (event: CoreEvent) => void;
  emitTransportState: (state: CallTransportState) => void;
  transport: CallTransport & { connected: CallTransportState[] };
  joinCall: ReturnType<typeof vi.fn>;
  leaveCall: ReturnType<typeof vi.fn>;
};

function harness(options: { encryptMedia?: boolean; joinError?: Error } = {}): Harness {
  const listeners = new Set<(event: CoreEvent) => void>();
  const transportListeners = new Set<(state: CallTransportState) => void>();
  const connected: CallTransportState[] = [];
  let currentTransportState = idleTransportState();
  const keys: { identity: string; keyIndex: number }[] = [];

  const transport = {
    connected,
    keys,
    connect: vi.fn(() => {
      const state = { ...idleTransportState(), connection: 'connected' as const };
      connected.push(state);
      currentTransportState = state;
      transportListeners.forEach((listener) => {
        listener(state);
      });
      return Promise.resolve();
    }),
    disconnect: vi.fn(() => Promise.resolve()),
    setMicrophoneEnabled: vi.fn(() => Promise.resolve()),
    setCameraEnabled: vi.fn(() => Promise.resolve()),
    setEncryptionKey: vi.fn((key: { identity: string; keyIndex: number }) => {
      keys.push({ identity: key.identity, keyIndex: key.keyIndex });
      return Promise.resolve();
    }),
    subscribe: (listener: (state: CallTransportState) => void) => {
      transportListeners.add(listener);
      listener(currentTransportState);
      return () => transportListeners.delete(listener);
    },
    getState: () => currentTransportState,
    capabilities: {},
  } as unknown as CallTransport & { connected: CallTransportState[] };

  const joinCall = vi.fn(() => {
    if (options.joinError) return Promise.reject(options.joinError);
    return Promise.resolve({
      session: 7,
      url: 'wss://sfu.example.org',
      jwt: 'jwt',
      identity: '@erwan:example.org:LAPTOP',
      encryptMedia: options.encryptMedia ?? false,
    });
  });
  const leaveCall = vi.fn(() => Promise.resolve());

  const client = {
    commands: { joinCall, leaveCall },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as CoreClient;

  return {
    client,
    emit: (event) => {
      listeners.forEach((listener) => {
        listener(event);
      });
    },
    emitTransportState: (state) => {
      currentTransportState = state;
      transportListeners.forEach((listener) => {
        listener(state);
      });
    },
    transport,
    joinCall,
    leaveCall,
  };
}

const ownKey = (session = 7): CoreEvent => ({
  type: 'call_encryption_key',
  session,
  identity: '@erwan:example.org:LAPTOP',
  key_index: 0,
  key: 'AAAAAAAAAAAAAAAAAAAAAA==',
  own: true,
  backend_id: null,
});

beforeEach(() => {
  resetCallOwner();
});

test('an unencrypted call connects without waiting for a key', async () => {
  const { client, transport } = harness();
  const session = new CallSession(client, { createTransport: () => transport });

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(session.lifecycle).toBe('active');
  expect(session.mediaReady).toBe(true);
  expect(transport.connect).toHaveBeenCalledOnce();
});

test('a call tears down after a successful join reports disconnected', async () => {
  const { client, transport, emitTransportState, leaveCall } = harness();
  const session = new CallSession(client, { createTransport: () => transport });

  await session.join('!room:example.org', { microphone: true, camera: false });
  expect(session.lifecycle).toBe('active');

  emitTransportState({ ...idleTransportState(), connection: 'disconnected' });

  expect(session.transport.connection).toBe('disconnected');
  expect(session.lifecycle).not.toBe('active');
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('failed');
    expect(session.failure).toBe('setup-failed');
    expect(leaveCall).toHaveBeenCalledOnce();
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  const retry = new CallSession(client, { createTransport: () => transport });
  await retry.join('!other:example.org', { microphone: true, camera: false });
  expect(retry.lifecycle).toBe('active');
});

test('a connect promise does not make the session active while transport is still connecting', async () => {
  const { client, transport, emitTransportState } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  let resolveConnect!: () => void;
  const connectResolved = new Promise<void>((resolve) => {
    resolveConnect = resolve;
  });
  transport.connect = vi.fn(async () => {
    emitTransportState({ ...idleTransportState(), connection: 'connecting' });
    await connectResolved;
  });

  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(transport.connect).toHaveBeenCalledOnce();
  });
  expect(session.transport.connection).toBe('connecting');
  expect(session.lifecycle).toBe('connecting');

  resolveConnect();
  await joining;
  expect(session.lifecycle).toBe('failed');
  expect(session.failure).toBe('setup-failed');
});

test('reconnecting and recovering leaves an active call intact', async () => {
  const { client, transport, emitTransportState } = harness();
  const session = new CallSession(client, { createTransport: () => transport });

  await session.join('!room:example.org', { microphone: true, camera: false });
  emitTransportState({ ...idleTransportState(), connection: 'reconnecting' });
  expect(session.lifecycle).toBe('active');

  emitTransportState({ ...idleTransportState(), connection: 'connected' });
  expect(session.lifecycle).toBe('active');
});

test('duplicate disconnected states tear down a call once', async () => {
  const { client, transport, emitTransportState, leaveCall } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  let resolveDisconnect!: () => void;
  transport.disconnect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveDisconnect = resolve;
      })
  );

  await session.join('!room:example.org', { microphone: true, camera: false });
  emitTransportState({ ...idleTransportState(), connection: 'disconnected' });
  emitTransportState({ ...idleTransportState(), connection: 'disconnected' });
  await vi.waitFor(() => {
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  const leaving = session.leave();
  resolveDisconnect();
  await leaving;

  expect(session.lifecycle).toBe('idle');
  expect(session.failure).toBeNull();
  expect(leaveCall).toHaveBeenCalledOnce();
  expect(transport.disconnect).toHaveBeenCalledOnce();
});

test('intentional leave does not become a transport failure', async () => {
  const { client, transport, emitTransportState } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  transport.disconnect = vi.fn(() => {
    emitTransportState({ ...idleTransportState(), connection: 'disconnected' });
    return Promise.resolve();
  });

  await session.join('!room:example.org', { microphone: true, camera: false });
  await session.leave();

  expect(session.lifecycle).toBe('idle');
  expect(session.failure).toBeNull();
  expect(transport.disconnect).toHaveBeenCalledOnce();
});

test('a second join is refused while a call is running', async () => {
  const { client, transport } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });

  const second = new CallSession(client, { createTransport: () => transport });
  await second.join('!other:example.org', { microphone: true, camera: false });

  expect(second.failure).toBe('busy');
});

test('an encrypted call holds until its own key arrives', async () => {
  const { client, transport, emit } = harness({ encryptMedia: true });
  const session = new CallSession(client, {
    createTransport: () => transport,
    e2eeSupported: () => true,
  });

  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('joining');
  });
  expect(transport.connect).not.toHaveBeenCalled();

  emit(ownKey());
  await joining;

  expect(session.mediaReady).toBe(true);
  expect(session.lifecycle).toBe('active');
});

test('a key emitted during the join is not lost', async () => {
  const listeners = new Set<(event: CoreEvent) => void>();
  const transport = harness({ encryptMedia: true }).transport;

  const client = {
    commands: {
      joinCall: vi.fn(() => {
        listeners.forEach((listener) => {
          listener(ownKey());
        });
        return Promise.resolve({
          session: 7,
          url: 'wss://sfu.example.org',
          jwt: 'jwt',
          identity: '@erwan:example.org:LAPTOP',
          encryptMedia: true,
        });
      }),
      leaveCall: vi.fn(() => Promise.resolve()),
    },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as CoreClient;

  const session = new CallSession(client, {
    createTransport: () => transport,
    e2eeSupported: () => true,
  });

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(session.lifecycle).toBe('active');
  expect(session.mediaReady).toBe(true);
});

test('an encrypted call refuses to start where e2ee is unsupported', async () => {
  const { client, transport, leaveCall } = harness({ encryptMedia: true });
  const session = new CallSession(client, {
    createTransport: () => transport,
    e2eeSupported: () => false,
  });

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(session.failure).toBe('e2ee-unsupported');
  expect(transport.connect).not.toHaveBeenCalled();
  expect(leaveCall).toHaveBeenCalledWith(7);
});

test('a room with no focus reports it rather than failing generically', async () => {
  const error = Object.assign(new Error('refused'), { detail: { code: 'no_call_focus' } });
  const { client, transport } = harness({ joinError: error });
  const session = new CallSession(client, { createTransport: () => transport });

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(session.failure).toBe('no-focus');
});

test('a key for another session is ignored', async () => {
  const { client, transport, emit } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });

  emit({
    type: 'call_members',
    session: 99,
    members: [
      {
        user_id: '@bob:example.org',
        device_id: 'X',
        identity: '@bob:example.org:X',
        backend_id: null,
      },
    ],
  });

  expect(session.members).toEqual([]);
});

test('leaving releases the lease and tells the core', async () => {
  const { client, transport, leaveCall } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });

  await session.leave();

  expect(session.lifecycle).toBe('idle');
  expect(leaveCall).toHaveBeenCalledWith(7);
  expect(transport.disconnect).toHaveBeenCalledOnce();

  const next = new CallSession(client, { createTransport: () => transport });
  await next.join('!other:example.org', { microphone: true, camera: false });
  expect(next.lifecycle).toBe('active');
});

test('a key arriving while the transport is still being built is not lost', async () => {
  const listeners = new Set<(event: CoreEvent) => void>();
  const transport = harness({ encryptMedia: true }).transport;

  const client = {
    commands: {
      joinCall: vi.fn(() =>
        Promise.resolve({
          session: 7,
          url: 'wss://sfu.example.org',
          jwt: 'jwt',
          identity: '@erwan:example.org:LAPTOP',
          encryptMedia: true,
        })
      ),
      leaveCall: vi.fn(() => Promise.resolve()),
    },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as CoreClient;

  const session = new CallSession(client, {
    e2eeSupported: () => true,
    createTransport: () => {
      listeners.forEach((listener) => {
        listener(ownKey());
      });
      return transport;
    },
  });

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(session.mediaReady).toBe(true);
  expect(session.lifecycle).toBe('active');
});

test('a failure stays attributed to the room it happened in', async () => {
  const error = Object.assign(new Error('refused'), { detail: { code: 'no_call_focus' } });
  const { client, transport } = harness({ joinError: error });
  const session = new CallSession(client, { createTransport: () => transport });

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(session.roomId).toBe('!room:example.org');

  session.clearFailure();
  expect(session.roomId).toBeNull();
  expect(session.failure).toBeNull();
});

function livekitHarness() {
  const listeners = new Set<(event: CoreEvent) => void>();
  const transportListeners = new Set<(state: CallTransportState) => void>();
  const keyProvider = new MatrixKeyProvider();
  const connects: CallTransportConnectOptions[] = [];
  let currentTransportState = idleTransportState();

  const transport = {
    room: {},
    keyProvider,
    connect: vi.fn((options: CallTransportConnectOptions) => {
      connects.push(options);
      currentTransportState = { ...idleTransportState(), connection: 'connected' };
      transportListeners.forEach((listener) => {
        listener(currentTransportState);
      });
      return Promise.resolve();
    }),
    disconnect: vi.fn(() => Promise.resolve()),
    setMicrophoneEnabled: vi.fn(() => Promise.resolve()),
    setCameraEnabled: vi.fn(() => Promise.resolve()),
    setEncryptionKey: vi.fn(() => Promise.resolve()),
    subscribe: (listener: (state: CallTransportState) => void) => {
      transportListeners.add(listener);
      listener(currentTransportState);
      return () => transportListeners.delete(listener);
    },
    getState: () => currentTransportState,
    capabilities: {},
  } as unknown as CallTransport;

  const client = {
    commands: {
      joinCall: vi.fn(() =>
        Promise.resolve({
          session: 7,
          url: 'wss://sfu.example.org',
          jwt: 'jwt',
          identity: '@erwan:example.org:LAPTOP',
          encryptMedia: true,
        })
      ),
      leaveCall: vi.fn(() => Promise.resolve()),
    },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as CoreClient;

  return {
    client,
    transport,
    connects,
    keyProvider,
    emit: (event: CoreEvent) => {
      listeners.forEach((listener) => {
        listener(event);
      });
    },
  };
}

test('an encrypted web call does not connect until the key is really on the ring', async () => {
  const { client, transport, keyProvider, emit } = livekitHarness();
  const session = new CallSession(client, {
    createTransport: () => transport,
    e2eeSupported: () => true,
  });

  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('joining');
  });

  emit(ownKey());

  expect(session.mediaReady).toBe(false);
  expect(transport.connect).not.toHaveBeenCalled();

  await joining;

  expect(keyProvider.state.ready).toBe(true);
  expect(session.mediaReady).toBe(true);
  expect(transport.connect).toHaveBeenCalledOnce();
});

test('a native call carries its own key into connect, before capture starts', async () => {
  const { client, transport, emit, emitTransportState } = harness({ encryptMedia: true });
  const connects: CallTransportConnectOptions[] = [];
  (transport as { connect: unknown }).connect = vi.fn((options: CallTransportConnectOptions) => {
    connects.push(options);
    emitTransportState({ ...idleTransportState(), connection: 'connected' });
    return Promise.resolve();
  });

  const session = new CallSession(client, {
    createTransport: () => transport,
    e2eeSupported: () => true,
  });

  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('joining');
  });
  emit(ownKey());
  await joining;

  expect(connects).toHaveLength(1);
  expect(connects[0].encryptionKeys.map((key) => key.identity)).toEqual([
    '@erwan:example.org:LAPTOP',
  ]);
  expect(session.mediaReady).toBe(true);
});

test('canceling while the grant is pending retracts the late grant and permits a new join', async () => {
  const h = harness();
  let resolveGrant!: (value: {
    session: number;
    url: string;
    jwt: string;
    identity: string;
    encryptMedia: boolean;
  }) => void;
  h.joinCall.mockReturnValueOnce(
    new Promise((resolve) => {
      resolveGrant = resolve;
    })
  );
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('joining');
  });
  await session.leave();
  resolveGrant({
    session: 7,
    url: 'wss://sfu.example.org',
    jwt: 'jwt',
    identity: '@erwan:example.org:LAPTOP',
    encryptMedia: false,
  });
  await joining;
  expect(session.lifecycle).toBe('idle');
  expect(h.leaveCall).toHaveBeenCalledOnce();
  await session.join('!room:example.org', { microphone: true, camera: false });
  expect(session.lifecycle).toBe('active');
});

test('a fatal signaling event cancels the current attempt before media starts', async () => {
  const h = harness();
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('active');
  });
  h.emit({
    type: 'call_signaling_error',
    session: 7,
    stage: 'sync',
    fatal: true,
  });
  await joining;
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('failed');
    expect(session.failure).toBe('setup-failed');
  });
  expect(h.transport.disconnect).toHaveBeenCalledOnce();
  expect(h.leaveCall).not.toHaveBeenCalled();
});

test('canceling while transport connect is pending never activates the stale attempt', async () => {
  const h = harness();
  let releaseConnect!: () => void;
  h.transport.connect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseConnect = resolve;
      })
  );
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(h.transport.connect).toHaveBeenCalledOnce();
  });
  await session.leave();
  releaseConnect();
  await joining;
  expect(session.lifecycle).toBe('idle');
  expect(h.transport.disconnect).toHaveBeenCalledOnce();
});

test('canceling while the own key gate is pending never starts transport', async () => {
  const h = harness({ encryptMedia: true });
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('joining');
  });
  await session.leave();
  await joining;
  expect(h.transport.connect).not.toHaveBeenCalled();
  expect(session.lifecycle).toBe('idle');
});

test('keys received while transport connects reach the transport before connect finishes', async () => {
  const h = harness();
  let releaseConnect!: () => void;
  h.transport.connect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        releaseConnect = resolve;
      })
  );
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(h.transport.connect).toHaveBeenCalledOnce();
  });
  h.emit({
    ...ownKey(),
    own: false,
    identity: '@remote:example.org:PHONE',
  } as CoreEvent);
  expect(h.transport.setEncryptionKey).toHaveBeenCalledWith(
    expect.objectContaining({ identity: '@remote:example.org:PHONE' }),
    undefined
  );
  h.emitTransportState({ ...idleTransportState(), connection: 'connected' });
  releaseConnect();
  await joining;
  expect(h.transport.setEncryptionKey).toHaveBeenCalled();
  expect(
    (h.transport.setEncryptionKey as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]
  ).toMatchObject({
    identity: '@remote:example.org:PHONE',
  });
});

test('latest backend snapshot before connect overrides the grant backends', async () => {
  const h = harness();
  const connect = vi.fn((options: CallTransportConnectOptions) => {
    void options;
    return Promise.resolve();
  });
  h.transport.connect = connect;
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  const joining = session.join('!room:example.org', { microphone: true, camera: false });
  h.emit({
    type: 'call_backends',
    session: 7,
    revision: 2,
    backends: [{ id: 'new', url: 'wss://new', jwt: 'jwt', identity: 'new' }],
  } as unknown as CoreEvent);
  await joining;
  expect(connect).toHaveBeenCalledWith(
    expect.objectContaining({ backends: [expect.objectContaining({ id: 'new' })] })
  );
});
