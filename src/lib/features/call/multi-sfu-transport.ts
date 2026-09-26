import QuickLRU from 'quick-lru';

import type { CallTelemetry } from './call-telemetry';
import type {
  CallBackendGrant,
  CallEncryptionKey,
  CallTransport,
  CallTransportConnectOptions,
  CallTransportRoom,
  CallTransportState,
} from './call-transport';
import { idleTransportState } from './call-transport';
import { createLivekitTransport, type LivekitTransport } from './livekit-transport';

export type MultiSfuTransportDeps = {
  createTransport?: (options: Parameters<typeof createLivekitTransport>[0]) => LivekitTransport;
};

const MAX_CACHED_KEYS = 512;

export function createMultiSfuTransport(
  encryptMedia: boolean,
  telemetry?: CallTelemetry,
  deps: MultiSfuTransportDeps = {}
): CallTransport {
  const transports = new Map<string, LivekitTransport>();
  const unsubscribes = new Map<string, () => void>();
  const listeners = new Set<(state: CallTransportState) => void>();
  const keys = new QuickLRU<string, CallEncryptionKey>({ maxSize: MAX_CACHED_KEYS });
  let publisherId: string | undefined;
  let microphoneEnabled = false;
  let cameraEnabled = false;
  let connectOptions: CallTransportConnectOptions | undefined;
  let state = idleTransportState();
  let generation = 0;
  let queue = Promise.resolve();
  let disposed = false;
  let desiredBackends = new Map<string, CallBackendGrant>();

  const cacheKey = (key: CallEncryptionKey): void => {
    keys.set(`${key.identity}\u0000${key.keyIndex}`, key);
  };

  const drop = async (backendId: string): Promise<void> => {
    const transport = transports.get(backendId);
    if (!transport) return;
    transports.delete(backendId);
    unsubscribes.get(backendId)?.();
    unsubscribes.delete(backendId);
    await transport.disconnect().catch(() => undefined);
  };

  const removeSubscriber = (backendId: string, transport: LivekitTransport): void => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        if (disposed || backendId === publisherId || transports.get(backendId) !== transport)
          return;
        transports.delete(backendId);
        unsubscribes.get(backendId)?.();
        unsubscribes.delete(backendId);
        await transport.disconnect().catch(() => undefined);
        publish();
      });
  };

  const publish = (): void => {
    const entries = [...transports.entries()].map(([backendId, transport]) => ({
      backendId,
      state: transport.getState(),
    }));
    const publisher = publisherId ? transports.get(publisherId)?.getState() : undefined;
    state = {
      ...(publisher ?? idleTransportState()),
      connection: publisher?.connection ?? 'disconnected',
      participants: entries.flatMap(({ backendId, state }) =>
        state.participants.map((participant) => ({ ...participant, backendId }))
      ),
    };
    for (const listener of listeners) listener({ ...state, participants: [...state.participants] });
  };

  const ensure = async (
    backend: CallBackendGrant,
    options: CallTransportConnectOptions,
    expectedGeneration: number
  ): Promise<void> => {
    if (transports.has(backend.id)) return;
    const telemetryAttributes = {
      'call.backend_id': backend.id,
      'call.backend_role': backend.id === publisherId ? 'publisher' : 'subscriber',
    };
    const transport = (deps.createTransport ?? createLivekitTransport)({
      encryptMedia,
      publishMedia: backend.id === publisherId,
      ownIdentity: backend.id === publisherId ? backend.identity : undefined,
      telemetry,
      telemetryAttributes,
    });
    transports.set(backend.id, transport);
    let connected = false;
    unsubscribes.set(
      backend.id,
      transport.subscribe((next) => {
        if (next.connection === 'connected') connected = true;
        publish();
        if (backend.id !== publisherId && connected && next.connection === 'disconnected') {
          removeSubscriber(backend.id, transport);
        }
      })
    );
    try {
      const encryptionKeys = [...keys.values()];
      await transport.connect({
        ...options,
        microphoneEnabled,
        cameraEnabled,
        url: backend.url,
        token: backend.jwt,
        encryptionKeys,
      });
      if (disposed || expectedGeneration !== generation) {
        if (!disposed && desiredBackends.has(backend.id)) return;
        transports.delete(backend.id);
        unsubscribes.get(backend.id)?.();
        unsubscribes.delete(backend.id);
        await transport.disconnect();
        return;
      }
    } catch (error) {
      telemetry?.failure('call.backend.connect', error, telemetryAttributes);
      if (backend.id === publisherId) throw error;
      transports.delete(backend.id);
      unsubscribes.get(backend.id)?.();
      unsubscribes.delete(backend.id);
      await transport.disconnect();
    }
  };

  const reconcile = async (
    backends: CallBackendGrant[],
    options?: CallTransportConnectOptions,
    expectedGeneration = generation,
    nextPublisherId?: string
  ): Promise<void> => {
    if (disposed || expectedGeneration !== generation) return;
    if (
      options &&
      nextPublisherId &&
      nextPublisherId !== publisherId &&
      backends.some((backend) => backend.id === nextPublisherId)
    ) {
      const previousId = publisherId;
      publisherId = nextPublisherId;
      await Promise.all(
        [nextPublisherId, previousId].filter((id) => id !== undefined).map((id) => drop(id))
      );
      if (expectedGeneration !== generation) return;
    }
    const wanted = new Set(backends.map((backend) => backend.id));
    await Promise.all(
      [...transports.entries()]
        .filter(([id]) => !wanted.has(id))
        .map(async ([id, transport]) => {
          if (expectedGeneration !== generation) return;
          transports.delete(id);
          unsubscribes.get(id)?.();
          unsubscribes.delete(id);
          await transport.disconnect();
        })
    );
    if (options && expectedGeneration === generation) {
      const publisher = backends.find((backend) => backend.id === publisherId);
      if (publisher) await ensure(publisher, options, expectedGeneration);
      if (expectedGeneration === generation) {
        await Promise.all(
          backends
            .filter((backend) => backend.id !== publisherId)
            .map((backend) => ensure(backend, options, expectedGeneration))
        );
      }
    }
    publish();
  };

  return {
    connect: async (options) => {
      if (disposed) throw new Error('transport-disposed');
      publisherId = options.publisherId;
      connectOptions = options;
      microphoneEnabled = options.microphoneEnabled;
      cameraEnabled = options.cameraEnabled;
      for (const key of options.encryptionKeys) cacheKey(key);
      const backends = options.backends ?? [];
      if (!publisherId || backends.length === 0) throw new Error('transport-not-connected');
      desiredBackends = new Map(backends.map((backend) => [backend.id, backend]));
      const expectedGeneration = ++generation;
      queue = queue
        .catch(() => undefined)
        .then(() => reconcile(backends, options, expectedGeneration));
      await queue;
      if (transports.get(publisherId)?.getState().connection !== 'connected') {
        throw new Error('transport-not-connected');
      }
    },
    disconnect: async () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      keys.clear();
      const results = await Promise.allSettled(
        [...transports.values()].map((transport) => transport.disconnect())
      );
      transports.clear();
      for (const unsubscribe of unsubscribes.values()) unsubscribe();
      unsubscribes.clear();
      publish();
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );
      if (failure) throw failure.reason;
    },
    setMicrophoneEnabled: async (enabled) => {
      microphoneEnabled = enabled;
      await transports.get(publisherId ?? '')?.setMicrophoneEnabled(enabled);
    },
    setCameraEnabled: async (enabled) => {
      cameraEnabled = enabled;
      await transports.get(publisherId ?? '')?.setCameraEnabled(enabled);
    },
    setEncryptionKey: async (key: CallEncryptionKey) => {
      if (disposed) return;
      cacheKey(key);
      await Promise.all(
        [...transports.values()].map((transport) => transport.setEncryptionKey(key))
      );
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    getState: () => ({ ...state, participants: [...state.participants] }),
    capabilities: {
      screenShare: {
        setEnabled: async (enabled) =>
          transports.get(publisherId ?? '')?.capabilities.screenShare?.setEnabled(enabled),
      },
    },
    reconcileBackends: async (backends, nextPublisherId) => {
      if (disposed) return;
      desiredBackends = new Map(backends.map((backend) => [backend.id, backend]));
      const expectedGeneration = ++generation;
      queue = queue
        .catch(() => undefined)
        .then(() => reconcile(backends, connectOptions, expectedGeneration, nextPublisherId));
      await queue;
    },
    rooms: (): readonly CallTransportRoom[] =>
      [...transports.entries()].map(([backendId, transport]) => ({
        backendId,
        room: transport.room,
      })),
    roomFor: (backendId) =>
      backendId ? transports.get(backendId)?.room : transports.get(publisherId ?? '')?.room,
  };
}
