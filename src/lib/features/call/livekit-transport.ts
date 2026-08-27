import {
  ConnectionQuality,
  Room as LivekitRoom,
  type RemoteParticipant,
  RoomEvent,
  Track,
  type TrackPublication,
} from 'livekit-client';

import type {
  CallConnectionQuality,
  CallEncryptionKey,
  CallParticipant,
  CallTrack,
  CallTransport,
  CallTransportConnectOptions,
  CallTransportState,
} from './call-transport';
import { idleTransportState, ignoreError } from './call-transport';
import { MatrixKeyProvider } from './key-provider';

const qualityOf = (quality: ConnectionQuality): CallConnectionQuality => {
  switch (quality) {
    case ConnectionQuality.Excellent:
      return 'excellent';
    case ConnectionQuality.Good:
      return 'good';
    case ConnectionQuality.Poor:
      return 'poor';
    case ConnectionQuality.Lost:
      return 'lost';
    default:
      return 'unknown';
  }
};

const trackOf = (publication: TrackPublication | undefined): CallTrack | undefined =>
  publication && {
    id: publication.trackSid,
    muted: publication.isMuted,
    subscribed: publication.isSubscribed,
  };

const participantOf = (participant: RemoteParticipant): CallParticipant => ({
  identity: participant.identity,
  camera: trackOf(participant.getTrackPublication(Track.Source.Camera)),
  screenShare: trackOf(participant.getTrackPublication(Track.Source.ScreenShare)),
  microphone: trackOf(participant.getTrackPublication(Track.Source.Microphone)),
  connectionQuality: qualityOf(participant.connectionQuality),
});

export type LivekitTransport = CallTransport & {
  readonly room: LivekitRoom;
  readonly keyProvider: MatrixKeyProvider | undefined;
};

export type LivekitTransportOptions = {
  encryptMedia: boolean;
  createRoom?: (options: ConstructorParameters<typeof LivekitRoom>[0]) => LivekitRoom;
  createWorker?: () => Worker;
};

const defaultWorker = (): Worker =>
  new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' });

export function createLivekitTransport(options: LivekitTransportOptions): LivekitTransport {
  const keyProvider = options.encryptMedia ? new MatrixKeyProvider() : undefined;
  const worker = keyProvider ? (options.createWorker ?? defaultWorker)() : undefined;

  const room = (options.createRoom ?? ((config) => new LivekitRoom(config)))({
    adaptiveStream: true,
    dynacast: false,
    ...(keyProvider && worker ? { encryption: { keyProvider, worker } } : {}),
  });

  let state: CallTransportState = idleTransportState();
  const listeners = new Set<(state: CallTransportState) => void>();
  let connected: Promise<void> | undefined;

  const publish = (changes: Partial<CallTransportState>): void => {
    state = { ...state, ...changes };
    const snapshot: CallTransportState = { ...state, participants: [...state.participants] };
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        ignoreError();
      }
    }
  };

  const syncParticipants = (): void => {
    publish({ participants: [...room.remoteParticipants.values()].map(participantOf) });
  };

  const syncLocal = (): void => {
    publish({
      microphoneEnabled: room.localParticipant.isMicrophoneEnabled,
      cameraEnabled: room.localParticipant.isCameraEnabled,
      screenShareEnabled: room.localParticipant.isScreenShareEnabled,
    });
  };

  room
    .on(RoomEvent.ParticipantConnected, syncParticipants)
    .on(RoomEvent.ParticipantDisconnected, syncParticipants)
    .on(RoomEvent.TrackSubscribed, syncParticipants)
    .on(RoomEvent.TrackUnsubscribed, syncParticipants)
    .on(RoomEvent.TrackPublished, syncParticipants)
    .on(RoomEvent.TrackUnpublished, syncParticipants)
    .on(RoomEvent.TrackMuted, syncParticipants)
    .on(RoomEvent.TrackUnmuted, syncParticipants)
    .on(RoomEvent.ConnectionQualityChanged, syncParticipants)
    .on(RoomEvent.LocalTrackPublished, syncLocal)
    .on(RoomEvent.LocalTrackUnpublished, syncLocal)
    .on(RoomEvent.Reconnecting, () => {
      publish({ connection: 'reconnecting' });
    })
    .on(RoomEvent.Reconnected, () => {
      publish({ connection: 'connected' });
    })
    .on(RoomEvent.Disconnected, () => {
      publish({ connection: 'disconnected', participants: [] });
    });

  const connect = async (connectOptions: CallTransportConnectOptions): Promise<void> => {
    publish({ connection: 'connecting', error: undefined });

    connected = (async () => {
      for (const key of connectOptions.encryptionKeys) keyProvider?.setKey(key, false);

      await room.connect(connectOptions.url, connectOptions.token);

      if (keyProvider) await room.setE2EEEnabled(true);

      await room.localParticipant.setMicrophoneEnabled(connectOptions.microphoneEnabled);
      await room.localParticipant.setCameraEnabled(connectOptions.cameraEnabled);

      publish({ connection: 'connected' });
      syncParticipants();
      syncLocal();
    })();

    try {
      await connected;
    } catch (error) {
      publish({
        connection: 'disconnected',
        error: error instanceof Error ? error.message : 'Could not connect to the call.',
      });
      throw error;
    }
  };

  return {
    room,
    keyProvider,
    connect,
    disconnect: async () => {
      await room.disconnect();
      worker?.terminate();
      keyProvider?.reset();
      publish({ connection: 'disconnected', participants: [] });
    },
    setMicrophoneEnabled: async (enabled) => {
      await room.localParticipant.setMicrophoneEnabled(enabled);
      syncLocal();
    },
    setCameraEnabled: async (enabled) => {
      await room.localParticipant.setCameraEnabled(enabled);
      syncLocal();
    },
    setEncryptionKey: (key: CallEncryptionKey) => {
      keyProvider?.setKey(key, false);
      return Promise.resolve();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    getState: () => ({ ...state, participants: [...state.participants] }),
    capabilities: {
      screenShare: {
        setEnabled: async (enabled) => {
          await room.localParticipant.setScreenShareEnabled(enabled);
          syncLocal();
        },
      },
    },
  };
}
