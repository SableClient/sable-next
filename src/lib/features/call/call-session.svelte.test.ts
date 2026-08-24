import { beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/CoreEvent';
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
  transport: CallTransport & { connected: CallTransportState[] };
  joinCall: ReturnType<typeof vi.fn>;
  leaveCall: ReturnType<typeof vi.fn>;
};

function harness(options: { encryptMedia?: boolean; joinError?: Error } = {}): Harness {
  const listeners = new Set<(event: CoreEvent) => void>();
  const connected: CallTransportState[] = [];
  const keys: { identity: string; keyIndex: number }[] = [];

  const transport = {
    connected,
    keys,
    connect: vi.fn(() => {
      connected.push(idleTransportState());
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
      listener(idleTransportState());
      return () => {};
    },
    getState: () => idleTransportState(),
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
    joinCall,
    leaveCall,
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
    members: [{ user_id: '@bob:example.org', device_id: 'X', identity: '@bob:example.org:X' }],
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
  const keyProvider = new MatrixKeyProvider();
  const connects: CallTransportConnectOptions[] = [];

  const transport = {
    room: {},
    keyProvider,
    connect: vi.fn((options: CallTransportConnectOptions) => {
      connects.push(options);
      return Promise.resolve();
    }),
    disconnect: vi.fn(() => Promise.resolve()),
    setMicrophoneEnabled: vi.fn(() => Promise.resolve()),
    setCameraEnabled: vi.fn(() => Promise.resolve()),
    setEncryptionKey: vi.fn(() => Promise.resolve()),
    subscribe: (listener: (state: CallTransportState) => void) => {
      listener(idleTransportState());
      return () => {};
    },
    getState: () => idleTransportState(),
    capabilities: {},
  } as unknown as CallTransport;

  const client = {
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
  const { client, transport, emit } = harness({ encryptMedia: true });
  const connects: CallTransportConnectOptions[] = [];
  (transport as { connect: unknown }).connect = vi.fn((options: CallTransportConnectOptions) => {
    connects.push(options);
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
