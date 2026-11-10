import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
import { type CallInputMode } from '#lib/settings/definitions.js';

const screenAudio = vi.hoisted(() => ({ supported: vi.fn(() => false) }));
vi.mock('#lib/platform/screen-audio.js', async (original) => ({
  ...(await original<typeof import('#lib/platform/screen-audio.js')>()),
  screenAudioSupported: screenAudio.supported,
}));

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/sveltekit', async (original) => ({
  ...(await original<typeof import('@sentry/sveltekit')>()),
  captureException: sentry.captureException,
}));

const sounds = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('#lib/features/notifications/sound.js', async (original) => {
  const actual = await original<typeof import('#lib/features/notifications/sound.js')>();
  return {
    ...actual,
    playSound: (...args: Parameters<typeof actual.playSound>) => {
      sounds.played.push(args[0]);
      return actual.playSound(...args);
    },
  };
});

let gains: { gain: { value: number } }[];
class MockAudioContext {
  state: AudioContextState = 'running';
  destination = {} as AudioDestinationNode;
  decodeAudioData = vi.fn<() => Promise<AudioBuffer>>().mockResolvedValue({} as AudioBuffer);
  resume = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  createBufferSource = vi.fn<() => AudioBufferSourceNode>(
    () =>
      ({
        addEventListener: vi.fn(),
        buffer: null,
        connect: vi.fn((node: AudioNode) => node),
        start: vi.fn(),
      }) as unknown as AudioBufferSourceNode
  );
  createGain = vi.fn<() => GainNode>(() => {
    const node = { gain: { value: 1 }, connect: vi.fn((next: AudioNode) => next) };
    gains.push(node);
    return node as unknown as GainNode;
  });
}

import { CallSession, TALK_RELEASE_DELAY_MS, voiceStates } from './call-session.svelte.js';
import { MatrixKeyProvider } from './key-provider';
import type { CallTransportConnectOptions } from './call-transport';
import { resetCallOwner } from './call-owner';
import type { CallTransport, CallTransportState } from './call-transport';
import { idleTransportState, ScreenAudioError } from './call-transport';

type Harness = {
  client: CoreClient;
  emit: (event: CoreEvent) => void;
  emitTransportState: (state: CallTransportState) => void;
  transport: CallTransport & { connected: CallTransportState[] };
  joinCall: ReturnType<typeof vi.fn>;
  leaveCall: ReturnType<typeof vi.fn>;
  setCallScreenSharing: ReturnType<typeof vi.fn>;
};

function harness(
  options: { encryptMedia?: boolean; joinError?: Error; canPublish?: boolean } = {}
): Harness {
  const listeners = new Set<(event: CoreEvent) => void>();
  const transportListeners = new Set<(state: CallTransportState) => void>();
  const connected: CallTransportState[] = [];
  let currentTransportState = idleTransportState();
  const keys: { identity: string; keyIndex: number }[] = [];

  const transport = {
    connected,
    keys,
    connect: vi.fn((options: CallTransportConnectOptions) => {
      const state = {
        ...idleTransportState(),
        connection: 'connected' as const,
        microphoneEnabled: options.microphoneEnabled,
        cameraEnabled: options.cameraEnabled,
      };
      connected.push(state);
      currentTransportState = state;
      transportListeners.forEach((listener) => {
        listener(state);
      });
      return Promise.resolve();
    }),
    disconnect: vi.fn(() => Promise.resolve()),
    setMicrophoneEnabled: vi.fn((enabled: boolean) => {
      currentTransportState = { ...currentTransportState, microphoneEnabled: enabled };
      transportListeners.forEach((listener) => {
        listener(currentTransportState);
      });
      return Promise.resolve();
    }),
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
      identity: '@kris:example.org:LAPTOP',
      encrypt_media: options.encryptMedia ?? false,
      mode: 'legacy',
      mode_reason: 'fresh',
      sticky_available: false,
      peer_modes: [],
      can_publish: options.canPublish ?? true,
      publisher_id: 'publisher',
      backends: [],
    });
  });
  const leaveCall = vi.fn(() => Promise.resolve());
  const setCallScreenSharing = vi.fn(() => Promise.resolve());

  const client = {
    rpc: { calls: { join: joinCall, leave: leaveCall, setScreenSharing: setCallScreenSharing } },
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
    setCallScreenSharing,
  };
}

const ownKey = (session = 7): CoreEvent => ({
  type: 'call_encryption_key',
  session,
  identity: '@kris:example.org:LAPTOP',
  key_index: 0,
  key: 'AAAAAAAAAAAAAAAAAAAAAA==',
  own: true,
  backend_id: null,
});

beforeEach(() => {
  globalThis.AudioContext = MockAudioContext as unknown as typeof AudioContext;
  gains = [];
  globalThis.fetch = vi.fn<() => Promise<Response>>().mockResolvedValue({
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
  } as Response);
  resetCallOwner();
  setPreference('callInputMode', 'voice-activity');
});

afterEach(() => {
  vi.useRealTimers();
  sentry.captureException.mockClear();
});

test('an unencrypted call connects without waiting for a key', async () => {
  const { client, transport } = harness();
  const session = new CallSession(client, { createTransport: () => transport });

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(session.lifecycle).toBe('active');
  expect(session.mediaReady).toBe(true);
  expect(transport.connect).toHaveBeenCalledOnce();
});

test('a call the account cannot publish to is joined listen-only', async () => {
  const { client, transport } = harness({ canPublish: false });
  const session = new CallSession(client, { createTransport: () => transport });

  await session.join('!room:example.org', { microphone: true, camera: true });
  await session.setMicrophoneEnabled(true);

  expect(session.lifecycle).toBe('active');
  expect(session.listenOnly).toBe(true);
  expect(transport.connect).toHaveBeenCalledWith(
    expect.objectContaining({ microphoneEnabled: false, cameraEnabled: false })
  );
  expect(transport.setMicrophoneEnabled).not.toHaveBeenCalled();
});

test('toggling a watched screen leaves other watched screens open', () => {
  const { client } = harness();
  const session = new CallSession(client);
  session.toggleWatchScreenShare('first');
  session.toggleWatchScreenShare('second');

  session.toggleWatchScreenShare('first');
  expect(session.watchedScreenShareIds).toEqual(['second']);

  session.toggleWatchScreenShare('first');
  expect(session.watchedScreenShareIds).toEqual(['second', 'first']);
});

test('joining clears screen shares watched in an earlier call', async () => {
  const { client, transport } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  session.toggleWatchScreenShare('screen');

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(session.watchedScreenShareIds).toEqual([]);
});

test('the core is told when the local screen share starts and stops', async () => {
  const { client, transport, emitTransportState, setCallScreenSharing } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });

  const connected = { ...idleTransportState(), connection: 'connected' as const };
  emitTransportState({ ...connected, screenShareEnabled: true });
  emitTransportState({ ...connected, screenShareEnabled: true });
  emitTransportState({ ...connected, screenShareEnabled: false });

  expect(setCallScreenSharing.mock.calls).toEqual([
    [{ session: 7, active: true }],
    [{ session: 7, active: false }],
  ]);
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
    rpc: {
      calls: {
        join: vi.fn(() => {
          listeners.forEach((listener) => {
            listener(ownKey());
          });
          return Promise.resolve({
            session: 7,
            url: 'wss://sfu.example.org',
            jwt: 'jwt',
            identity: '@kris:example.org:LAPTOP',
            encrypt_media: true,
            mode: 'compatibility',
            mode_reason: 'fresh',
            sticky_available: false,
            peer_modes: [],
            can_publish: true,
            publisher_id: 'publisher',
            backends: [],
          });
        }),
        leave: vi.fn(() => Promise.resolve()),
      },
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
  expect(leaveCall).toHaveBeenCalledWith({ session: 7 });
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
        joined_ts: 0,
        screen_sharing: false,
      },
    ],
  });

  expect(session.members).toEqual([]);
});

test('the call is timed from the earliest member still in it', async () => {
  const { client, transport, emit } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  const connectedAt = session.connectedAt ?? 0;
  const member = (device: string, joined: number) => ({
    user_id: '@bob:example.org',
    device_id: device,
    identity: `@bob:example.org:${device}`,
    backend_id: null,
    joined_ts: joined,
    screen_sharing: false,
  });

  emit({
    type: 'call_members',
    session: 7,
    members: [member('X', connectedAt - 7_200_000), member('Y', connectedAt - 60_000)],
  });
  expect(session.startedAt).toBe(connectedAt - 7_200_000);

  emit({ type: 'call_members', session: 7, members: [member('Y', connectedAt + 5_000)] });
  expect(session.startedAt).toBe(connectedAt);
});

test('leaving releases the lease and tells the core', async () => {
  const { client, transport, leaveCall } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });

  await session.leave();

  expect(session.lifecycle).toBe('idle');
  expect(leaveCall).toHaveBeenCalledWith({ session: 7 });
  expect(transport.disconnect).toHaveBeenCalledOnce();

  const next = new CallSession(client, { createTransport: () => transport });
  await next.join('!other:example.org', { microphone: true, camera: false });
  expect(next.lifecycle).toBe('active');
});

test('a key arriving while the transport is still being built is not lost', async () => {
  const listeners = new Set<(event: CoreEvent) => void>();
  const transport = harness({ encryptMedia: true }).transport;

  const client = {
    rpc: {
      calls: {
        join: vi.fn(() =>
          Promise.resolve({
            session: 7,
            url: 'wss://sfu.example.org',
            jwt: 'jwt',
            identity: '@kris:example.org:LAPTOP',
            encrypt_media: true,
            mode: 'compatibility',
            mode_reason: 'fresh',
            sticky_available: false,
            peer_modes: [],
            can_publish: true,
            publisher_id: 'publisher',
            backends: [],
          })
        ),
        leave: vi.fn(() => Promise.resolve()),
      },
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
    rpc: {
      calls: {
        join: vi.fn(() =>
          Promise.resolve({
            session: 7,
            url: 'wss://sfu.example.org',
            jwt: 'jwt',
            identity: '@kris:example.org:LAPTOP',
            encrypt_media: true,
            mode: 'compatibility',
            mode_reason: 'fresh',
            sticky_available: false,
            peer_modes: [],
            can_publish: true,
            publisher_id: 'publisher',
            backends: [],
          })
        ),
        leave: vi.fn(() => Promise.resolve()),
      },
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
    '@kris:example.org:LAPTOP',
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
    encrypt_media: boolean;
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
    identity: '@kris:example.org:LAPTOP',
    encrypt_media: false,
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
    publisher_id: 'new',
    backends: [{ id: 'new', url: 'wss://new', jwt: 'jwt', identity: 'new' }],
  });
  await joining;
  expect(connect).toHaveBeenCalledWith(
    expect.objectContaining({
      publisherId: 'new',
      backends: [expect.objectContaining({ id: 'new' })],
    })
  );
});

test('a join sends the camera intent', async () => {
  const h = harness();
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  await session.join('!room:example.org', { microphone: true, camera: true });
  expect(h.joinCall).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    livekit_service_url: null,
    mode: null,
    intent: 'video',
  });
  await session.leave();
  await session.join('!room:example.org', { microphone: true, camera: false });
  expect(h.joinCall).toHaveBeenLastCalledWith({
    room_id: '!room:example.org',
    livekit_service_url: null,
    mode: null,
    intent: 'audio',
  });
});

test('a backend snapshot after connect forwards its publisher id', async () => {
  const h = harness();
  const reconcileBackends = vi.fn(() => Promise.resolve());
  h.transport.reconcileBackends = reconcileBackends;
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  const backends = [
    { id: 'old', url: 'wss://old', jwt: 'old', identity: 'me' },
    { id: 'new', url: 'wss://new', jwt: 'new', identity: 'me' },
  ];
  h.emit({ type: 'call_backends', session: 7, revision: 3, publisher_id: 'new', backends });
  expect(reconcileBackends).toHaveBeenCalledWith(backends, 'new');
});

test('deafening mutes the microphone and undeafening restores it', async () => {
  const { client, transport, emitTransportState } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  emitTransportState({ ...idleTransportState(), connection: 'connected', microphoneEnabled: true });

  session.setDeafened(true);
  await vi.waitFor(() => {
    expect(transport.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
  });

  session.setDeafened(false);
  await vi.waitFor(() => {
    expect(transport.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });
});

test('undeafening leaves a microphone muted before deafening muted', async () => {
  const { client, transport, emitTransportState } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: false, camera: false });
  emitTransportState({
    ...idleTransportState(),
    connection: 'connected',
    microphoneEnabled: false,
  });
  vi.mocked(transport.setMicrophoneEnabled).mockClear();

  session.setDeafened(true);
  session.setDeafened(false);

  expect(transport.setMicrophoneEnabled).not.toHaveBeenCalled();
});

test('unmuting while deafened undeafens', async () => {
  const { client, transport, emitTransportState } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  emitTransportState({ ...idleTransportState(), connection: 'connected', microphoneEnabled: true });

  session.setDeafened(true);
  await session.setMicrophoneEnabled(true);

  expect(session.deafened).toBe(false);
});

test.each(['leave', 'disconnect', 'signaling failure'] as const)(
  '%s clears deafen state before the next call',
  async (ending) => {
    const h = harness();
    const session = new CallSession(h.client, { createTransport: () => h.transport });
    await session.join('!room:example.org', { microphone: true, camera: false });
    h.emitTransportState({
      ...idleTransportState(),
      connection: 'connected',
      microphoneEnabled: true,
    });
    session.setDeafened(true);
    vi.mocked(h.transport.setMicrophoneEnabled).mockClear();

    if (ending === 'leave') await session.leave();
    else if (ending === 'disconnect') h.emitTransportState(idleTransportState());
    else h.emit({ type: 'call_signaling_error', session: 7, stage: 'sync', fatal: true });

    await vi.waitFor(() => {
      expect(session.lifecycle).toBe(ending === 'leave' ? 'idle' : 'failed');
    });
    expect(session.deafened).toBe(false);
    expect(h.transport.setMicrophoneEnabled).not.toHaveBeenCalled();

    await session.join('!other:example.org', { microphone: true, camera: false });
    expect(h.transport.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ microphoneEnabled: true })
    );
    expect(session.deafened).toBe(false);
    await session.leave();
  }
);

test('the microphone mute is remembered for the next call', async () => {
  const { client, transport } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  expect(preferences.callMicrophoneMuted).toBe(false);

  await session.setMicrophoneEnabled(false);
  await session.leave();
  expect(preferences.callMicrophoneMuted).toBe(true);

  await session.join('!room:example.org', { microphone: true, camera: false });
  expect(preferences.callMicrophoneMuted).toBe(false);
});

async function microphoneSession(mode: CallInputMode, microphone = true, canPublish = true) {
  setPreference('callInputMode', mode);
  const h = harness({ canPublish });
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  await session.join('!room:example.org', { microphone, camera: false });
  return { ...h, session };
}

async function releaseTalk(session: CallSession, source?: string) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const release = session.setTalking(false, source);
  await vi.advanceTimersByTimeAsync(TALK_RELEASE_DELAY_MS);
  vi.useRealTimers();
  await release;
}

test('push-to-talk connects without transmitting, and transmits only while pressed', async () => {
  const { session, transport } = await microphoneSession('push-to-talk');
  expect(transport.connect).toHaveBeenCalledWith(
    expect.objectContaining({ microphoneEnabled: false, microphoneStandby: true })
  );
  expect(session.microphoneEnabled).toBe(true);
  await session.setTalking(true);
  expect(session.transport.microphoneEnabled).toBe(true);
  await releaseTalk(session);
  expect(session.transport.microphoneEnabled).toBe(false);
  expect(preferences.callMicrophoneMuted).toBe(false);
});

test('push-to-talk keeps transmitting briefly after release and through a quick re-press', async () => {
  const { session, transport } = await microphoneSession('push-to-talk');
  await session.setTalking(true);
  vi.mocked(transport.setMicrophoneEnabled).mockClear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const release = session.setTalking(false);
  await vi.advanceTimersByTimeAsync(TALK_RELEASE_DELAY_MS - 1);
  expect(session.transport.microphoneEnabled).toBe(true);
  await session.setTalking(true);
  await release;
  await vi.advanceTimersByTimeAsync(TALK_RELEASE_DELAY_MS);
  expect(transport.setMicrophoneEnabled).not.toHaveBeenCalled();
  expect(session.transport.microphoneEnabled).toBe(true);
  const second = session.setTalking(false);
  await vi.advanceTimersByTimeAsync(TALK_RELEASE_DELAY_MS);
  await second;
  expect(session.transport.microphoneEnabled).toBe(false);
});

test('the mute shortcut toggles on each press', async () => {
  const { session } = await microphoneSession('voice-activity');
  await session.toggleMicrophone();
  expect(session.transport.microphoneEnabled).toBe(false);
  expect(preferences.callMicrophoneMuted).toBe(true);
  await session.toggleMicrophone();
  expect(session.transport.microphoneEnabled).toBe(true);
  expect(preferences.callMicrophoneMuted).toBe(false);
});

test('the talk key has no effect in voice activity mode', async () => {
  const { session, transport } = await microphoneSession('voice-activity');
  await session.setTalking(true);
  await session.setTalking(false);
  expect(transport.setMicrophoneEnabled).not.toHaveBeenCalled();
});

test.each(['voice-activity', 'push-to-talk'] as const)(
  'held keys never override a manual mute in %s mode',
  async (mode) => {
    const { session, transport } = await microphoneSession(mode, false);
    await session.setTalking(true);
    await releaseTalk(session);
    expect(transport.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(preferences.callMicrophoneMuted).toBe(true);
  }
);

test('the mute shortcut overrides a held talk key', async () => {
  const { session } = await microphoneSession('push-to-talk');
  await session.setTalking(true);
  await session.toggleMicrophone();
  expect(session.transport.microphoneEnabled).toBe(false);
  await releaseTalk(session);
  await session.toggleMicrophone();
  expect(session.transport.microphoneEnabled).toBe(false);
  await session.setTalking(true);
  expect(session.transport.microphoneEnabled).toBe(true);
});

test('releasing one talk source keeps transmitting while another source is held', async () => {
  const { session } = await microphoneSession('push-to-talk');
  await session.setTalking(true, 'desktop');
  await session.setTalking(true, 'button');
  await releaseTalk(session, 'desktop');
  expect(session.transport.microphoneEnabled).toBe(true);
  await releaseTalk(session, 'button');
  expect(session.transport.microphoneEnabled).toBe(false);
});

test('deafening stops push-to-talk and requires a fresh press after undeafening', async () => {
  const { session } = await microphoneSession('push-to-talk');
  await session.setTalking(true);
  session.setDeafened(true);
  await session.setTalking(true);
  await vi.waitFor(() => {
    expect(session.transport.microphoneEnabled).toBe(false);
  });
  expect(session.deafened).toBe(true);
  session.setDeafened(false);
  await session.setTalking(false);
  expect(session.transport.microphoneEnabled).toBe(false);
  await session.setTalking(true);
  expect(session.transport.microphoneEnabled).toBe(true);
});

test('switching input modes during a call clears held keys and respects manual mute', async () => {
  const { session } = await microphoneSession('voice-activity');
  session.setInputMode('push-to-talk');
  await vi.waitFor(() => {
    expect(session.transport.microphoneEnabled).toBe(false);
  });
  await session.setTalking(true);
  session.setInputMode('voice-activity');
  await session.setTalking(false);
  expect(session.transport.microphoneEnabled).toBe(true);
  await session.setMicrophoneEnabled(false);
  session.setInputMode('push-to-talk');
  session.setInputMode('voice-activity');
  await vi.waitFor(() => {
    expect(session.transport.microphoneEnabled).toBe(false);
  });
});

test('quickly releasing a talk key waits for a pending unmute before muting again', async () => {
  const { session, transport, emitTransportState } = await microphoneSession('push-to-talk');
  let finishUnmute!: () => void;
  vi.mocked(transport.setMicrophoneEnabled).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishUnmute = () => {
          emitTransportState({ ...session.transport, microphoneEnabled: true });
          resolve();
        };
      })
  );
  const press = session.setTalking(true);
  await vi.waitFor(() => {
    expect(transport.setMicrophoneEnabled).toHaveBeenCalledExactlyOnceWith(true);
  });
  const release = session.setTalking(false);
  finishUnmute();
  await Promise.all([press, release]);
  expect(transport.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
  expect(session.transport.microphoneEnabled).toBe(false);
});

test('listen-only calls ignore held microphone shortcuts', async () => {
  const { session, transport } = await microphoneSession('push-to-talk', true, false);
  await session.setTalking(true);
  expect(transport.setMicrophoneEnabled).not.toHaveBeenCalled();
});

test('leaving clears held keys before joining another push-to-talk call', async () => {
  const { session } = await microphoneSession('push-to-talk');
  await session.setTalking(true);
  await session.leave();
  await session.join('!other:example.org', { microphone: true, camera: false });
  await session.setTalking(false);
  expect(session.transport.microphoneEnabled).toBe(false);
});

test('selecting push-to-talk while connecting mutes before join completes', async () => {
  const { client, transport } = harness();
  const connect = vi.mocked(transport.connect).getMockImplementation();
  let finishConnect!: () => void;
  vi.spyOn(transport, 'connect').mockImplementation(async (options) => {
    await connect?.(options);
    await new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
  });
  const session = new CallSession(client, { createTransport: () => transport });
  const join = session.join('!room:example.org', { microphone: true, camera: false });
  await vi.waitFor(() => {
    expect(finishConnect).toBeDefined();
  });
  session.setInputMode('push-to-talk');
  finishConnect();
  await join;
  expect(session.transport.microphoneEnabled).toBe(false);
});

test('a camera that cannot start is reported, not swallowed', async () => {
  const { client, transport } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  vi.mocked(transport.setCameraEnabled).mockRejectedValueOnce(new Error('NotAllowedError'));

  await session.setCameraEnabled(true);

  expect(session.deviceError).toBe('camera');
  session.clearDeviceError();
  expect(session.deviceError).toBeNull();
});

test('camera warnings expire without retrying', async () => {
  vi.useFakeTimers();
  const { client, transport, emitTransportState } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  vi.mocked(transport.setCameraEnabled).mockRejectedValue(
    new DOMException('No camera found', 'NotFoundError')
  );

  await session.setCameraEnabled(true);
  expect(session.deviceError).toBe('camera');

  vi.advanceTimersByTime(5_000);
  expect(session.deviceError).toBeNull();
  emitTransportState({ ...idleTransportState(), connection: 'reconnecting' });
  emitTransportState({ ...idleTransportState(), connection: 'connected' });
  expect(session.deviceError).toBeNull();
  expect(transport.setCameraEnabled).toHaveBeenCalledOnce();

  await session.setCameraEnabled(true);
  expect(session.deviceError).toBe('camera');
  await session.leave();
});

test.each(['camera', 'microphone'] as const)(
  'repeated %s failures restart the warning timeout',
  async (kind) => {
    vi.useFakeTimers();
    const { client, transport } = harness();
    const session = new CallSession(client, { createTransport: () => transport });
    await session.join('!room:example.org', { microphone: true, camera: false });
    const error = new DOMException('Device not found', 'NotFoundError');
    vi.mocked(transport.setCameraEnabled).mockRejectedValue(error);
    vi.mocked(transport.setMicrophoneEnabled).mockRejectedValue(error);

    await session.setCameraEnabled(true);
    vi.advanceTimersByTime(4_000);
    if (kind === 'camera') await session.setCameraEnabled(true);
    else await session.setMicrophoneEnabled(true);

    vi.advanceTimersByTime(1_000);
    expect(session.deviceError).toBe(kind);
    vi.advanceTimersByTime(4_000);
    expect(session.deviceError).toBeNull();
    await session.leave();
  }
);

test.each(['dismiss', 'recover', 'leave'])(
  '%s cancels the device warning timer',
  async (action) => {
    vi.useFakeTimers();
    const { client, transport } = harness();
    const session = new CallSession(client, { createTransport: () => transport });
    await session.join('!room:example.org', { microphone: true, camera: false });
    vi.mocked(transport.setCameraEnabled).mockRejectedValueOnce(
      new DOMException('Device not found', 'NotFoundError')
    );

    await session.setCameraEnabled(true);
    expect(session.deviceError).toBe('camera');
    expect(vi.getTimerCount()).toBe(1);

    if (action === 'dismiss') session.clearDeviceError();
    else if (action === 'recover') await session.setCameraEnabled(true);
    else await session.leave();

    expect(session.deviceError).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await session.leave();
  }
);

test('a transport with a camera switch flips the camera through it', async () => {
  const { client, transport } = harness();
  const flip = vi.fn(() => Promise.resolve());
  const session = new CallSession(client, { createTransport: () => transport });
  expect(session.canSwitchCamera).toBe(false);
  transport.capabilities.camera = { switch: flip };
  await session.join('!room:example.org', { microphone: true, camera: true });

  expect(session.canSwitchCamera).toBe(true);
  await session.switchCamera();
  expect(flip).toHaveBeenCalledOnce();

  flip.mockRejectedValueOnce(new Error('media_failed'));
  await session.switchCamera();
  expect(session.deviceError).toBe('camera');
});

test('two devices of one account keep their own voice state', () => {
  const member = (device: string) => ({
    user_id: '@me:x',
    device_id: device,
    identity: `@me:x:${device}`,
    backend_id: null,
    joined_ts: 0,
    screen_sharing: false,
  });
  const states = voiceStates(
    [member('BBBB'), member('AAAA')],
    [
      { identity: '@me:x:BBBB', speaking: true, microphone: { muted: false } },
      { identity: '@me:x:AAAA', speaking: false, microphone: { muted: false } },
    ] as never,
    false
  );

  expect(states.get('@me:x')?.speaking).toBe(false);
  expect(states.get('@me:x#1')?.speaking).toBe(true);
});

test('a screen shared without its sound is reported as a sound failure', async () => {
  const { client, transport } = harness();
  const setEnabled = vi.fn(() => Promise.reject(new ScreenAudioError()));
  transport.capabilities = { screenShare: { setEnabled } };
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });

  await session.shareScreenWith({ kind: 'system', exclude: [] });

  expect(session.deviceError).toBe('screenAudio');
});

test('the screen sound picker precedes the screen share when sound can be captured', async () => {
  const { client, transport } = harness();
  const setEnabled = vi.fn(() => Promise.resolve());
  transport.capabilities = { screenShare: { setEnabled } };
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  screenAudio.supported.mockReturnValue(true);

  await session.toggleScreenShare();
  expect(session.choosingScreenAudio).toBe(true);
  expect(setEnabled).not.toHaveBeenCalled();

  await session.shareScreenWith({ kind: 'none' });
  expect(setEnabled).toHaveBeenLastCalledWith(true, { kind: 'none' });
  screenAudio.supported.mockReturnValue(false);
});

test('toggling a running screen share stops it without reopening a picker', async () => {
  const { client, transport, emitTransportState } = harness();
  const setEnabled = vi.fn(() => Promise.resolve());
  transport.capabilities = { screenShare: { setEnabled } };
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  emitTransportState({
    ...idleTransportState(),
    connection: 'connected',
    screenShareEnabled: true,
  });

  await session.toggleScreenShare();

  expect(setEnabled).toHaveBeenCalledExactlyOnceWith(false);
  expect(session.choosingScreenAudio).toBe(false);
});

test('leaving closes the screen sound picker', async () => {
  const { client, transport } = harness();
  transport.capabilities = { screenShare: { setEnabled: vi.fn(() => Promise.resolve()) } };
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  screenAudio.supported.mockReturnValue(true);
  await session.toggleScreenShare();
  screenAudio.supported.mockReturnValue(false);

  await session.leave();

  expect(session.choosingScreenAudio).toBe(false);
});

test('a camera failure that lands after leaving is not reported', async () => {
  const { client, transport } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  let fail = (_error: Error) => {};
  vi.mocked(transport.setCameraEnabled).mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      })
  );

  const enabling = session.setCameraEnabled(true);
  await session.leave();
  fail(new Error('NotAllowedError'));
  await enabling;

  expect(session.deviceError).toBeNull();
});

test.each(['AbortError', 'NotAllowedError'])(
  'a screen picker cancelled with %s stays silent',
  async (name) => {
    const { client, transport } = harness();
    const cancelled = new DOMException('cancelled', name);
    transport.capabilities = {
      screenShare: { setEnabled: vi.fn(() => Promise.reject(cancelled)) },
    };
    const session = new CallSession(client, { createTransport: () => transport });
    await session.join('!room:example.org', { microphone: true, camera: false });
    sounds.played.length = 0;

    await session.toggleScreenShare();

    expect(session.deviceError).toBeNull();
    expect(sounds.played).not.toContain('screenshare_start');
  }
);

test('a started screen share plays its sound', async () => {
  const { client, transport } = harness();
  transport.capabilities = { screenShare: { setEnabled: vi.fn(() => Promise.resolve()) } };
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });
  sounds.played.length = 0;

  await session.toggleScreenShare();

  expect(sounds.played).toContain('screenshare_start');
});

const reportedCause = (): string =>
  (sentry.captureException.mock.calls[0] as [Error, { tags: Record<string, string> }])[1].tags[
    'call.error_category'
  ];

test('an abnormal disconnect after joining is reported once with the livekit reason', async () => {
  const { client, transport, emitTransportState } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });

  emitTransportState({
    ...idleTransportState(),
    connection: 'disconnected',
    disconnectReason: 'CONNECTION_TIMEOUT',
  });
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('failed');
  });

  expect(sentry.captureException).toHaveBeenCalledOnce();
  expect(reportedCause()).toBe('disconnect.CONNECTION_TIMEOUT');
});

test('a server-side room end is not reported', async () => {
  const { client, transport, emitTransportState } = harness();
  const session = new CallSession(client, { createTransport: () => transport });
  await session.join('!room:example.org', { microphone: true, camera: false });

  emitTransportState({
    ...idleTransportState(),
    connection: 'disconnected',
    disconnectReason: 'ROOM_DELETED',
  });
  await vi.waitFor(() => {
    expect(session.lifecycle).toBe('failed');
  });

  expect(sentry.captureException).not.toHaveBeenCalled();
});

test('a failed join reports the core error instead of a placeholder', async () => {
  const error = Object.assign(new Error('rpc failed'), {
    detail: { code: 'failed', log_id: 'log-9' },
  });
  const { client, transport } = harness({ joinError: error });
  const session = new CallSession(client, { createTransport: () => transport });

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(sentry.captureException).toHaveBeenCalledOnce();
  expect(reportedCause()).toBe('code.failed');
});

test('a join cancelled by a denied device is not reported', async () => {
  const { client, transport } = harness();
  transport.connect = vi.fn(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));
  const session = new CallSession(client, { createTransport: () => transport });

  await session.join('!room:example.org', { microphone: true, camera: false });

  expect(session.lifecycle).toBe('failed');
  expect(sentry.captureException).not.toHaveBeenCalled();
});

test('a non-fatal signaling error stays a breadcrumb', async () => {
  const h = harness();
  const session = new CallSession(h.client, { createTransport: () => h.transport });
  await session.join('!room:example.org', { microphone: true, camera: false });

  h.emit({ type: 'call_signaling_error', session: 7, stage: 'sync', fatal: false });

  expect(session.lifecycle).toBe('active');
  expect(sentry.captureException).not.toHaveBeenCalled();
});
