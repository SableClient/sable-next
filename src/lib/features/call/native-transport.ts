import type {
  NativeCallSnapshot,
  NativeCallRemoteParticipant,
} from '@sableclient/tauri-plugin-livekit-mobile';

import { loadNativeCalls } from '#lib/platform/calls.js';

import type {
  CallConnectionQuality,
  CallEncryptionKey,
  CallParticipant,
  CallTransport,
  CallTransportConnection,
  CallTransportState,
} from './call-transport';
import { idleTransportState, ignoreError } from './call-transport';

type Plugin = NonNullable<Awaited<ReturnType<typeof loadNativeCalls>>>;

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

const participantOf = (participant: NativeCallRemoteParticipant): CallParticipant => ({
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
  microphone: participant.microphone && {
    id: participant.microphone.sid,
    muted: participant.microphone.muted,
    subscribed: participant.microphone.subscribed,
  },
  connectionQuality: qualityOf(participant.connectionQuality),
});

const stateOf = (snapshot: NativeCallSnapshot): CallTransportState => ({
  connection: connectionOf(snapshot.connectionState),
  participants: (snapshot.remoteParticipants ?? []).map(participantOf),
  microphoneEnabled: snapshot.microphoneEnabled,
  cameraEnabled: snapshot.cameraEnabled,
  screenShareEnabled: snapshot.screenShareEnabled,
  error: snapshot.lastError?.message,
});

export type NativeTransport = CallTransport & { readonly callId: string };

export async function createNativeTransport(callId: string): Promise<NativeTransport | null> {
  const plugin: Plugin | null = await loadNativeCalls();
  if (!plugin) return null;

  let state = idleTransportState();
  let revision = -1;
  const listeners = new Set<(state: CallTransportState) => void>();
  let unlisten: (() => void) | undefined;
  const queuedKeys: CallEncryptionKey[] = [];
  let connected = false;

  const adopt = (snapshot: NativeCallSnapshot): void => {
    if (snapshot.revision <= revision) return;
    revision = snapshot.revision;
    state = stateOf(snapshot);
    const view: CallTransportState = { ...state, participants: [...state.participants] };
    for (const listener of listeners) {
      try {
        listener(view);
      } catch {
        ignoreError();
      }
    }
  };

  const encode = (key: CallEncryptionKey): string => btoa(String.fromCharCode(...key.key));

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
      unlisten = await plugin.listenNativeCallSnapshot(adopt);
      adopt(
        await plugin.connectNativeCall({
          callId,
          url: options.url,
          token: options.token,
          microphoneEnabled: options.microphoneEnabled,
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

      if (options.cameraEnabled) {
        adopt(await plugin.setNativeCallCameraEnabled({ callId, enabled: true }));
      }
    },
    disconnect: async () => {
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
    setEncryptionKey: async (key) => {
      if (!connected) {
        queuedKeys.push(key);
        return;
      }
      await pushKey(key);
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
      screenShare: {
        setEnabled: async (enabled) => {
          adopt(await plugin.setNativeCallScreenShareEnabled({ callId, enabled }));
        },
      },
    },
  };
}
