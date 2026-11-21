import type {
  NativeCallSnapshot,
  NativeCallRemoteParticipant,
} from '@sableclient/tauri-plugin-livekit-mobile';
import { uint8ArrayToBase64 } from 'uint8array-extras';

import { loadNativeCalls } from '#lib/platform/calls.js';
import { isAndroid } from '#lib/platform/os.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import type {
  CallBackendGrant,
  CallConnectionQuality,
  CallEncryptionKey,
  CallParticipant,
  CallTransport,
  CallTransportConnection,
  CallTransportState,
} from './call-transport';
import { idleTransportState, ignoreError } from './call-transport';

type Plugin = NonNullable<Awaited<ReturnType<typeof loadNativeCalls>>>;

const RETRY_FIRST_MS = 2_000;
const RETRY_MAX_MS = 30_000;

const QUALITIES = new Set<CallConnectionQuality>(['lost', 'poor', 'good', 'excellent']);

const qualityOf = (value: string | undefined): CallConnectionQuality =>
  QUALITIES.has(value as CallConnectionQuality) ? (value as CallConnectionQuality) : 'unknown';

const connectionOf = (state: NativeCallSnapshot['connectionState']): CallTransportConnection => {
  switch (state) {
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'reconnecting':
      return 'reconnecting';
    default:
      return 'disconnected';
  }
};

type NativeParticipant = NativeCallRemoteParticipant & {
  screenShareAudio?: NativeCallRemoteParticipant['microphone'];
};

const participantOf = (participant: NativeParticipant): CallParticipant => ({
  identity: participant.identity,
  camera: participant.camera && {
    id: participant.camera.sid,
    muted: participant.camera.muted,
    subscribed: participant.camera.subscribed,
  },
  screenShare: participant.screenShare && {
    id: participant.screenShare.sid,
    muted: participant.screenShare.muted,
    subscribed: participant.screenShare.subscribed,
  },
  screenShareAudio: participant.screenShareAudio && {
    id: participant.screenShareAudio.sid,
    muted: participant.screenShareAudio.muted,
    subscribed: participant.screenShareAudio.subscribed,
  },
  microphone: participant.microphone && {
    id: participant.microphone.sid,
    muted: participant.microphone.muted,
    subscribed: participant.microphone.subscribed,
  },
  connectionQuality: qualityOf(participant.connectionQuality),
});

const selfOf = (snapshot: NativeCallSnapshot, identity: string): CallParticipant => ({
  identity,
  local: true,
  camera: snapshot.cameraEnabled ? { id: 'camera', muted: false, subscribed: true } : undefined,
  microphone: { id: 'microphone', muted: !snapshot.microphoneEnabled, subscribed: true },
  connectionQuality: qualityOf(snapshot.localConnectionQuality),
});

const stateOf = (snapshot: NativeCallSnapshot, identity: string): CallTransportState => ({
  connection: connectionOf(snapshot.connectionState),
  participants: (snapshot.remoteParticipants ?? []).map(participantOf),
  self: selfOf(snapshot, identity),
  microphoneEnabled: snapshot.microphoneEnabled,
  cameraEnabled: snapshot.cameraEnabled,
  screenShareEnabled: snapshot.screenShareEnabled,
  error: snapshot.lastError?.message,
  errorCode: snapshot.lastError?.code,
});

export type NativeTransport = CallTransport & { readonly callId: string };

export async function createNativeTransport(
  callId: string,
  identity: string,
  callerName?: string
): Promise<NativeTransport | null> {
  const plugin: Plugin | null = await loadNativeCalls();
  if (!plugin) return null;

  let state = idleTransportState();
  let revision = -1;
  const listeners = new Set<(state: CallTransportState) => void>();
  let unlisten: (() => void) | undefined;
  const queuedKeys: CallEncryptionKey[] = [];
  let connected = false;
  let disposed = false;
  let backends: CallBackendGrant[] = [];
  let publisherId: string | undefined;
  let subscribed: string[] = [];
  let unreachable: string[] = [];
  let latest: NativeCallSnapshot | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_FIRST_MS;

  const publish = (): void => {
    if (!latest) return;
    state = {
      ...stateOf(latest, identity),
      ...(unreachable.length > 0 ? { unreachableBackends: unreachable } : {}),
    };
    const view: CallTransportState = { ...state, participants: [...state.participants] };
    for (const listener of listeners) {
      try {
        listener(view);
      } catch (error) {
        console.warn('[sable call] state listener failed', error);
      }
    }
  };

  const adopt = (snapshot: NativeCallSnapshot): void => {
    if (snapshot.revision <= revision) return;
    revision = snapshot.revision;
    latest = snapshot;
    subscribed = snapshot.subscriberBackends ?? [];
    unreachable = unreachable.filter((id) => !subscribed.includes(id));
    publish();
  };

  const missing = (): string[] =>
    backends.map(({ id }) => id).filter((id) => id !== publisherId && !subscribed.includes(id));

  const reconcile = async (): Promise<void> => {
    if (!publisherId || backends.length === 0) return;
    adopt(
      await plugin.reconcileNativeCallBackends({
        callId,
        publisherId,
        backends: backends.map(({ id, url, jwt }) => ({ id, url, token: jwt })),
      })
    );
    scheduleRetry();
  };

  const scheduleRetry = (): void => {
    if (disposed || retryTimer !== undefined || missing().length === 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (disposed) return;
      unreachable = missing();
      publish();
      if (unreachable.length === 0) {
        retryDelay = RETRY_FIRST_MS;
        return;
      }
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      void reconcile().catch(ignoreError);
    }, retryDelay);
  };

  const encode = (key: CallEncryptionKey): string => uint8ArrayToBase64(key.key);

  const pushKey = async (key: CallEncryptionKey): Promise<void> => {
    adopt(
      await plugin.setNativeCallEncryptionKey({
        callId,
        identity: key.identity,
        keyIndex: key.keyIndex,
        key: encode(key),
      })
    );
  };

  return {
    callId,
    connect: async (options) => {
      const stop = await plugin.listenNativeCallSnapshot(adopt);
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      const publisher = options.backends?.find(({ id }) => id === options.publisherId);
      adopt(
        await plugin.connectNativeCall({
          callId,
          url: publisher?.url ?? options.url,
          token: publisher?.jwt ?? options.token,
          microphoneEnabled: options.microphoneEnabled,
          audioProcessing: {
            echoCancellation: preferences.echoCancellation,
            noiseSuppression: preferences.noiseSuppression,
            autoGainControl: preferences.autoGainControl,
          },
          callerName,
          encryptionKeys: options.encryptionKeys.map((key) => ({
            identity: key.identity,
            keyIndex: key.keyIndex,
            key: encode(key),
          })),
        })
      );
      connected = true;

      const pending = queuedKeys.splice(0, queuedKeys.length);
      for (const key of pending) await pushKey(key);

      if (publisher) {
        backends = options.backends ?? [];
        publisherId = options.publisherId;
        await reconcile();
      }

      if (options.cameraEnabled) {
        try {
          adopt(await plugin.setNativeCallCameraEnabled({ callId, enabled: true }));
        } catch (error) {
          console.warn('[sable call] could not enable camera', error);
        }
      }
    },
    disconnect: async () => {
      disposed = true;
      clearTimeout(retryTimer);
      try {
        adopt(await plugin.disconnectNativeCall({ callId }));
      } finally {
        connected = false;
        unlisten?.();
        unlisten = undefined;
      }
    },
    setMicrophoneEnabled: async (enabled) => {
      adopt(await plugin.setNativeCallMicrophoneEnabled({ callId, enabled }));
    },
    setCameraEnabled: async (enabled) => {
      adopt(await plugin.setNativeCallCameraEnabled({ callId, enabled }));
    },
    setParticipantVolume: async (identity, volume, screen = false) => {
      const request = { callId, identity, volume, screenShare: screen };
      adopt(await plugin.setNativeCallParticipantVolume(request));
    },
    setEncryptionKey: async (key) => {
      if (!connected) {
        queuedKeys.push(key);
        return;
      }
      await pushKey(key);
    },
    reconcileBackends: async (next, nextPublisherId) => {
      backends = next;
      publisherId = nextPublisherId ?? publisherId;
      if (connected && !disposed) await reconcile();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener({ ...state, participants: [...state.participants] });
      return () => listeners.delete(listener);
    },
    getState: () => ({ ...state, participants: [...state.participants] }),
    capabilities: {
      camera: {
        switch: async () => {
          adopt(await plugin.switchNativeCallCamera({ callId }));
        },
      },
      localVideo: {
        place: async (rect) => {
          adopt(await plugin.setNativeCallLocalVideoOverlay({ callId, ...rect }));
        },
        clear: async () => {
          adopt(await plugin.clearNativeCallLocalVideoOverlay({ callId }));
        },
      },
      remoteVideo: {
        place: async ({ identity, trackId, ...rect }) => {
          adopt(
            await plugin.setNativeCallRemoteVideoOverlay({
              callId,
              participantIdentity: identity,
              trackId,
              ...rect,
            })
          );
        },
        clear: async (trackId) => {
          adopt(await plugin.clearNativeCallRemoteVideoOverlay({ callId, trackId }));
        },
      },
      audioRoutes: {
        list: async () => {
          const response = await plugin.getAudioRoutes({ callId });
          adopt(response.receiver);
          return response.routes;
        },
        select: async (routeId) => {
          adopt(await plugin.setAudioRoute({ callId, routeId }));
        },
      },
      audioInputs: isAndroid()
        ? {
            list: async () => {
              const response = await plugin.getAudioRoutes({ callId });
              adopt(response.receiver);
              return response.inputs ?? [];
            },
            select: async (inputId) => {
              adopt(await plugin.setAudioInput({ callId, inputId }));
            },
          }
        : undefined,
      screenShare: {
        setEnabled: async (enabled) => {
          adopt(await plugin.setNativeCallScreenShareEnabled({ callId, enabled }));
        },
      },
    },
  };
}
