import {
  ConnectionQuality,
  ConnectionState,
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
import type { CallTelemetry } from './call-telemetry';

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
  publishMedia?: boolean;
  ownIdentity?: string;
  telemetry?: Pick<CallTelemetry, 'step' | 'event' | 'failure'>;
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
  let disposed = false;
  const isDisposed = (): boolean => disposed;
  let healthTimer: ReturnType<typeof setTimeout> | undefined;
  let healthGeneration = 0;
  let qualitySnapshot = '';

  const fail = (stage: string, error: unknown): void => options.telemetry?.failure(stage, error);
  const step = <T>(stage: string, action: () => Promise<T>): Promise<T> =>
    options.telemetry ? options.telemetry.step(stage, action) : action();
  const event = (stage: string, attributes: Record<string, string | number | boolean> = {}): void =>
    options.telemetry?.event(stage, attributes);

  const mediaCounts = () => {
    let audioPublished = 0;
    let audioSubscribed = 0;
    for (const participant of room.remoteParticipants.values()) {
      const publication = participant.getTrackPublication(Track.Source.Microphone);
      if (publication) {
        audioPublished += 1;
        if (publication.isSubscribed && publication.track) audioSubscribed += 1;
      }
    }
    return { audioPublished, audioSubscribed };
  };

  const keyMatchCount = (): number => {
    const keys = keyProvider?.getKeys() ?? [];
    let matches = 0;
    for (const participant of room.remoteParticipants.values()) {
      if (keys.some((key) => key.participantIdentity === participant.identity)) matches += 1;
    }
    return matches;
  };

  const scheduleHealth = (delay = 10_000): void => {
    if (!options.telemetry || disposed) return;
    const generation = healthGeneration;
    healthTimer = setTimeout(() => {
      healthTimer = undefined;
      void healthSnapshot().finally(() => {
        if (
          !disposed &&
          generation === healthGeneration &&
          room.state !== ConnectionState.Disconnected
        ) {
          scheduleHealth(30_000);
        }
      });
    }, delay);
  };

  const healthSnapshot = async (): Promise<void> => {
    const generation = healthGeneration;
    if (disposed) return;
    const localTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as
      | { getSenderStats: () => Promise<{ bytesSent?: number } | undefined> }
      | undefined;
    const remoteTracks = [...room.remoteParticipants.values()]
      .map(
        (participant) =>
          participant.getTrackPublication(Track.Source.Microphone)?.track as unknown as
            | { getReceiverStats: () => Promise<{ bytesReceived?: number } | undefined> }
            | undefined
      )
      .filter(
        (
          track
        ): track is { getReceiverStats: () => Promise<{ bytesReceived?: number } | undefined> } =>
          typeof track?.getReceiverStats === 'function'
      );
    const [sender, ...receivers] = await Promise.all([
      localTrack?.getSenderStats().catch((error: unknown) => {
        fail('call.media.health.sender_stats', error);
        return undefined;
      }),
      ...remoteTracks.map((track) =>
        track.getReceiverStats().catch((error: unknown) => {
          fail('call.media.health.receiver_stats', error);
          return undefined;
        })
      ),
    ]);
    if (generation !== healthGeneration) return;
    const counts = mediaCounts();
    event('call.media.health', {
      'audio.sender_bytes': sender?.bytesSent ?? 0,
      'audio.receiver_bytes': receivers.reduce(
        (total, stats) => total + (stats?.bytesReceived ?? 0),
        0
      ),
      'audio.sender_stats_available': sender ? 1 : 0,
      'audio.receiver_stats_available': receivers.filter(Boolean).length,
      'audio.microphone_requested': state.microphoneEnabled,
      'audio.microphone_effective': room.localParticipant.isMicrophoneEnabled,
      'audio.subscribed_track_count': counts.audioSubscribed,
      'audio.key_matched_participant_count': keyMatchCount(),
      'audio.playback_allowed': room.canPlaybackAudio,
    });
  };

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
    const participants = [...room.remoteParticipants.values()].map(participantOf);
    publish({ participants });
    const nextQuality = participants.map((participant) => participant.connectionQuality).join(',');
    if (nextQuality !== qualitySnapshot) {
      qualitySnapshot = nextQuality;
      event('call.media.quality_snapshot', { 'call.participant_count': participants.length });
    }
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
      event('call.connection.reconnecting');
    })
    .on(RoomEvent.SignalReconnecting, () => {
      event('call.connection.signal_reconnecting');
    })
    .on(RoomEvent.Reconnected, () => {
      publish({ connection: 'connected' });
      event('call.connection.reconnected');
    })
    .on(RoomEvent.Disconnected, (reason) => {
      publish({ connection: 'disconnected', participants: [] });
      event('call.connection.disconnected', { 'call.disconnect_reason': reason ?? -1 });
      healthGeneration += 1;
      if (healthTimer) clearTimeout(healthTimer);
      healthTimer = undefined;
    })
    .on(RoomEvent.ConnectionStateChanged, (connectionState) => {
      event('call.connection.state', { 'call.connection_state': connectionState });
    })
    .on(RoomEvent.EncryptionError, (error) => {
      fail('call.encryption.error', error);
    })
    .on(RoomEvent.MediaDevicesError, (error) => {
      fail('call.media.device_error', error);
    })
    .on(RoomEvent.TrackSubscriptionFailed, (_trackSid, _participant, reason) => {
      fail('call.media.track_subscription', reason ?? new Error('OperationError'));
    })
    .on(RoomEvent.LocalAudioSilenceDetected, () => {
      event('call.media.local_audio_silence');
    })
    .on(RoomEvent.ParticipantConnected, () => {
      event('call.media.participant_count', {
        'call.participant_count': room.remoteParticipants.size,
      });
    })
    .on(RoomEvent.ParticipantDisconnected, () => {
      event('call.media.participant_count', {
        'call.participant_count': room.remoteParticipants.size,
      });
    });

  const connect = async (connectOptions: CallTransportConnectOptions): Promise<void> => {
    if (isDisposed()) throw new Error('call-cancelled');
    publish({ connection: 'connecting', error: undefined });

    connected = (async () => {
      for (const key of connectOptions.encryptionKeys) {
        keyProvider?.setKey(key, key.identity === options.ownIdentity);
      }

      const ownIdentity = options.ownIdentity;
      if (keyProvider && ownIdentity) {
        await step('call.encryption.publisher_key', () => keyProvider.waitForOwnKey(ownIdentity));
      }
      if (isDisposed()) throw new Error('call-cancelled');

      await step('call.livekit.connect', () =>
        room.connect(connectOptions.url, connectOptions.token)
      );
      await checkConnection();

      if (keyProvider) await step('call.encryption.enable', () => room.setE2EEEnabled(true));
      await checkConnection();

      if (options.publishMedia !== false) {
        await step('call.microphone.set', () =>
          room.localParticipant.setMicrophoneEnabled(connectOptions.microphoneEnabled)
        );
        await checkConnection();
        await step('call.camera.set', () =>
          room.localParticipant.setCameraEnabled(connectOptions.cameraEnabled)
        );
        await checkConnection();
      }

      if (room.state !== ConnectionState.Connected) throw new Error('transport-not-connected');

      publish({ connection: 'connected' });
      syncParticipants();
      syncLocal();
      scheduleHealth();
    })();

    try {
      await connected;
    } catch (error) {
      if (!isDisposed()) fail('call.livekit.connect', error);
      publish({
        connection: 'disconnected',
        error: error instanceof Error ? error.message : 'Could not connect to the call.',
      });
      throw error;
    }
  };

  const checkConnection = async (): Promise<void> => {
    if (disposed) {
      await room.disconnect();
      throw new Error('call-cancelled');
    }
    if (room.state !== ConnectionState.Connected) throw new Error('transport-not-connected');
  };

  return {
    room,
    keyProvider,
    connect,
    disconnect: async () => {
      disposed = true;
      healthGeneration += 1;
      if (healthTimer) clearTimeout(healthTimer);
      healthTimer = undefined;
      try {
        await room.disconnect();
      } finally {
        worker?.terminate();
        keyProvider?.reset();
        publish({ connection: 'disconnected', participants: [] });
      }
    },
    setMicrophoneEnabled: async (enabled) => {
      if (disposed || options.publishMedia === false) return;
      await step('call.microphone.set', () => room.localParticipant.setMicrophoneEnabled(enabled));
      syncLocal();
    },
    setCameraEnabled: async (enabled) => {
      if (disposed || options.publishMedia === false) return;
      await step('call.camera.set', () => room.localParticipant.setCameraEnabled(enabled));
      syncLocal();
    },
    setEncryptionKey: (key: CallEncryptionKey) => {
      if (!disposed) keyProvider?.setKey(key, key.identity === options.ownIdentity);
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
          if (disposed || options.publishMedia === false) return;
          await step('call.screen_share.set', () =>
            room.localParticipant.setScreenShareEnabled(enabled)
          );
          syncLocal();
        },
      },
    },
  };
}
