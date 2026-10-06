import {
  AudioPresets,
  ConnectionQuality,
  ConnectionState,
  LocalAudioTrack,
  LocalVideoTrack,
  Room as LivekitRoom,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type LocalParticipant,
  type RemoteParticipant,
  RoomEvent,
  Track,
  type TrackPublication,
} from 'livekit-client';

import {
  captureScreenAudio,
  type ScreenAudioChoice,
  screenAudioSupported,
  stopScreenAudio,
} from '#lib/platform/screen-audio.js';
import { startHdrShare, stopHdrShare } from '#lib/platform/hdr-share.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import type {
  CallConnectionQuality,
  CallEncryptionKey,
  CallParticipant,
  CallTrack,
  CallTransport,
  CallTransportConnectOptions,
  CallTransportState,
} from './call-transport';
import { idleTransportState, ignoreError, ScreenAudioError } from './call-transport';
import { MatrixKeyProvider } from './key-provider';
import { createMicrophoneFilter, supportsVoiceFilter } from './voice-filter';
import { screenCaptureOptions, videoPublishOptions, videoResolution } from './video-quality';
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

const selfOf = (participant: LocalParticipant): CallParticipant => ({
  identity: participant.identity,
  local: true,
  camera: trackOf(participant.getTrackPublication(Track.Source.Camera)),
  screenShare: trackOf(participant.getTrackPublication(Track.Source.ScreenShare)),
  screenShareAudio: trackOf(participant.getTrackPublication(Track.Source.ScreenShareAudio)),
  microphone: trackOf(participant.getTrackPublication(Track.Source.Microphone)),
  connectionQuality: qualityOf(participant.connectionQuality),
  speaking: participant.isSpeaking,
});

const participantOf = (participant: RemoteParticipant): CallParticipant => ({
  identity: participant.identity,
  camera: trackOf(participant.getTrackPublication(Track.Source.Camera)),
  screenShare: trackOf(participant.getTrackPublication(Track.Source.ScreenShare)),
  screenShareAudio: trackOf(participant.getTrackPublication(Track.Source.ScreenShareAudio)),
  microphone: trackOf(participant.getTrackPublication(Track.Source.Microphone)),
  connectionQuality: qualityOf(participant.connectionQuality),
  speaking: participant.isSpeaking,
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
  telemetryAttributes?: Record<string, string | number | boolean>;
  createRoom?: (options: ConstructorParameters<typeof LivekitRoom>[0]) => LivekitRoom;
  createWorker?: () => Worker;
};

const defaultWorker = (): Worker =>
  new Worker(new URL('livekit-client/e2ee-worker', import.meta.url), { type: 'module' });

const SCREEN_AUDIO_PUBLISH: TrackPublishOptions = {
  audioPreset: AudioPresets.musicHighQualityStereo,
  forceStereo: true,
  dtx: false,
  red: false,
};

const DISPLAY_AUDIO_CAPTURE: ScreenShareCaptureOptions = {
  audio: {
    channelCount: 2,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    restrictOwnAudio: true,
  },
  systemAudio: 'include',
};

export function createLivekitTransport(options: LivekitTransportOptions): LivekitTransport {
  const keyProvider = options.encryptMedia ? new MatrixKeyProvider() : undefined;
  const worker = keyProvider ? (options.createWorker ?? defaultWorker)() : undefined;
  const voiceIsolation = preferences.noiseSuppression && preferences.voiceIsolation;
  const filterMicrophone = voiceIsolation && supportsVoiceFilter();
  const cameraCapture = {
    ...(preferences.videoInputDevice ? { deviceId: preferences.videoInputDevice } : {}),
    ...(preferences.callCameraResolution !== 'auto'
      ? { resolution: videoResolution(preferences.callCameraResolution) }
      : {}),
  };
  const cameraPublish = videoPublishOptions(
    'camera',
    preferences.callCameraBitrate,
    preferences.callCameraCodec,
    preferences.callSimulcast
  );
  const screenCapture: ScreenShareCaptureOptions = screenCaptureOptions(
    preferences.callScreenResolution,
    preferences.callScreenFramerate
  );
  const screenPublish = videoPublishOptions(
    'screen',
    preferences.callScreenBitrate,
    preferences.callScreenCodec,
    preferences.callSimulcast,
    preferences.callScreenFramerate
  );

  const room = (options.createRoom ?? ((config) => new LivekitRoom(config)))({
    adaptiveStream: true,
    dynacast: false,
    audioCaptureDefaults: {
      echoCancellation: preferences.echoCancellation,
      noiseSuppression: preferences.noiseSuppression && !filterMicrophone,
      autoGainControl: preferences.autoGainControl,
      ...(voiceIsolation && !filterMicrophone ? { voiceIsolation: true } : {}),
      ...(preferences.audioInputDevice ? { deviceId: preferences.audioInputDevice } : {}),
    },
    videoCaptureDefaults: cameraCapture,
    ...(preferences.audioOutputDevice
      ? { audioOutput: { deviceId: preferences.audioOutputDevice } }
      : {}),
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
  const participantIndexes = new WeakMap<object, number>();
  let nextParticipantIndex = 0;

  const fail = (
    stage: string,
    error: unknown,
    attributes: Record<string, string | number | boolean> = {}
  ): void =>
    options.telemetry?.failure(stage, error, { ...options.telemetryAttributes, ...attributes });
  const step = <T>(
    stage: string,
    action: () => Promise<T>,
    attributes: Record<string, string | number | boolean> = {}
  ): Promise<T> =>
    options.telemetry
      ? options.telemetry.step(stage, action, { ...options.telemetryAttributes, ...attributes })
      : action();
  const event = (stage: string, attributes: Record<string, string | number | boolean> = {}): void =>
    options.telemetry?.event(stage, { ...options.telemetryAttributes, ...attributes });

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

  const participantIndex = (participant: RemoteParticipant): number => {
    const existing = participantIndexes.get(participant);
    if (existing !== undefined) return existing;
    const index = nextParticipantIndex++;
    participantIndexes.set(participant, index);
    return index;
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
    const participants = [...room.remoteParticipants.values()];
    const remoteTracks = participants.map((participant) => {
      const publication = participant.getTrackPublication(Track.Source.Microphone);
      const track = publication?.track as unknown as
        | {
            getReceiverStats: () => Promise<
              | {
                  bytesReceived?: number;
                  totalAudioEnergy?: number;
                  totalSamplesDuration?: number;
                }
              | undefined
            >;
          }
        | undefined;
      return { participant, publication, track, index: participantIndex(participant) };
    });
    const [sender, ...receivers] = await Promise.all([
      localTrack?.getSenderStats().catch((error: unknown) => {
        fail('call.media.health.sender_stats', error);
        return undefined;
      }),
      ...remoteTracks.map(({ track, index }) =>
        typeof track?.getReceiverStats === 'function'
          ? track.getReceiverStats().catch((error: unknown) => {
              fail('call.media.health.receiver_stats', error, { 'call.participant_index': index });
              return undefined;
            })
          : Promise.resolve(undefined)
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
    for (const [position, { participant, publication, index }] of remoteTracks.entries()) {
      const receiver = receivers[position];
      event('call.media.receiver_health', {
        'call.participant_index': index,
        'audio.key_present': (keyProvider?.getKeys() ?? []).some(
          (key) => key.participantIdentity === participant.identity
        ),
        'audio.published': Boolean(publication),
        'audio.subscribed': Boolean(publication?.isSubscribed),
        'audio.muted': Boolean(publication?.isMuted),
        'audio.receiver_stats_available': Boolean(receiver),
        'audio.receiver_bytes': receiver?.bytesReceived ?? 0,
        'audio.receiver_total_audio_energy': receiver?.totalAudioEnergy ?? 0,
        'audio.receiver_total_samples_duration': receiver?.totalSamplesDuration ?? 0,
      });
    }
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
      self: selfOf(room.localParticipant),
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
    .on(RoomEvent.ActiveSpeakersChanged, syncParticipants)
    .on(RoomEvent.ActiveSpeakersChanged, syncLocal)
    .on(RoomEvent.LocalTrackPublished, syncLocal)
    .on(RoomEvent.LocalTrackUnpublished, syncLocal)
    .on(RoomEvent.LocalTrackUnpublished, (publication) => {
      if (publication.source === Track.Source.ScreenShare) void stopSharingAudio();
    })
    .on(RoomEvent.TrackMuted, syncLocal)
    .on(RoomEvent.TrackUnmuted, syncLocal)
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
      void stopSharingAudio();
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
    .on(RoomEvent.LocalTrackPublished, (publication) => {
      const track = publication.track;
      if (!filterMicrophone || !(track instanceof LocalAudioTrack)) return;
      if (publication.source !== Track.Source.Microphone) return;
      const filter = createMicrophoneFilter();
      void step('call.microphone.filter', () => track.setProcessor(filter)).catch(() => {
        void filter.destroy().catch(ignoreError);
        return track.applyConstraints({ noiseSuppression: true }).catch(ignoreError);
      });
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
        void keyProvider?.setKey(key, key.identity === options.ownIdentity);
      }
      await keyProvider?.flush();

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
        await publishTrack('call.microphone.set', () =>
          room.localParticipant.setMicrophoneEnabled(connectOptions.microphoneEnabled)
        );
        await publishTrack('call.camera.set', () =>
          room.localParticipant.setCameraEnabled(
            connectOptions.cameraEnabled,
            cameraCapture,
            cameraPublish
          )
        );
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

  let screenAudio: LocalAudioTrack | null = null;
  let screenAudioGeneration = 0;
  let screenAudioTask: Promise<boolean> = Promise.resolve(true);
  let hdrScreen: LocalVideoTrack | null = null;

  const stopHdrScreen = async (): Promise<void> => {
    const track = hdrScreen;
    hdrScreen = null;
    if (!track) return;
    await room.localParticipant.unpublishTrack(track, true).catch(ignoreError);
    await stopHdrShare().catch((error: unknown) => {
      fail('call.screen_share.hdr_stop', error);
    });
  };

  const stopSharingAudio = (): Promise<void> => {
    screenAudioGeneration += 1;
    const track = screenAudio;
    screenAudio = null;
    if (!track) return Promise.resolve();
    track.stop();
    const cleanup = (async () => {
      await room.localParticipant.unpublishTrack(track, false).catch(ignoreError);
      await stopScreenAudio().catch((error: unknown) => {
        fail('call.screen_share.audio_stop', error);
      });
    })();
    screenAudioTask = Promise.all([screenAudioTask, cleanup]).then(() => true);
    return cleanup;
  };

  const shareAudio = (choice: ScreenAudioChoice | undefined): Promise<boolean> => {
    if (!choice || choice.kind === 'none' || !screenAudioSupported() || screenAudio)
      return Promise.resolve(true);
    const generation = screenAudioGeneration;
    screenAudioTask = screenAudioTask.then(async () => {
      if (isDisposed() || generation !== screenAudioGeneration || screenAudio) return true;
      try {
        const captured = await captureScreenAudio(choice);
        if (isDisposed() || generation !== screenAudioGeneration) {
          captured.stop();
          await stopScreenAudio();
          return true;
        }
        const track = new LocalAudioTrack(captured, undefined, true);
        screenAudio = track;
        await room.localParticipant.publishTrack(track, {
          ...SCREEN_AUDIO_PUBLISH,
          source: Track.Source.ScreenShareAudio,
        });
        return true;
      } catch (error) {
        if (isDisposed() || generation !== screenAudioGeneration) return true;
        fail('call.screen_share.audio', error);
        await stopSharingAudio();
        return false;
      }
    });
    return screenAudioTask;
  };

  const publishTrack = async (stage: string, enable: () => Promise<unknown>): Promise<void> => {
    try {
      await step(stage, enable);
    } catch (error) {
      fail(stage, error);
    }
    await checkConnection();
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
        await stopSharingAudio();
        await stopHdrScreen();
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
      await step('call.camera.set', () =>
        room.localParticipant.setCameraEnabled(enabled, cameraCapture, cameraPublish)
      );
      syncLocal();
    },
    setEncryptionKey: (key: CallEncryptionKey) =>
      disposed
        ? Promise.resolve()
        : (keyProvider?.setKey(key, key.identity === options.ownIdentity) ?? Promise.resolve()),
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    getState: () => ({ ...state, participants: [...state.participants] }),
    capabilities: {
      screenShare: {
        setEnabled: async (enabled, audio, source) => {
          if (disposed || options.publishMedia === false) return;
          if (enabled && source?.kind === 'hdr') {
            await step('call.screen_share.hdr', async () => {
              const track = new LocalVideoTrack(
                await startHdrShare(
                  source.monitor,
                  () => {
                    void stopHdrScreen().then(stopSharingAudio).then(syncLocal);
                  },
                  screenCapture.resolution
                ),
                undefined,
                true
              );
              hdrScreen = track;
              await room.localParticipant.publishTrack(track, {
                ...screenPublish,
                source: Track.Source.ScreenShare,
              });
            });
            const audioShared = await shareAudio(audio);
            syncLocal();
            if (!audioShared) throw new ScreenAudioError();
            return;
          }
          if (!enabled && hdrScreen) {
            await stopHdrScreen();
            await stopSharingAudio();
            syncLocal();
            return;
          }
          await step('call.screen_share.set', () => {
            if (!enabled) return room.localParticipant.setScreenShareEnabled(false);
            const browserAudio = !screenAudioSupported();
            return room.localParticipant.setScreenShareEnabled(
              true,
              { ...(browserAudio ? DISPLAY_AUDIO_CAPTURE : {}), ...screenCapture },
              { ...(browserAudio ? SCREEN_AUDIO_PUBLISH : {}), ...screenPublish }
            );
          });
          const audioShared =
            enabled && room.localParticipant.isScreenShareEnabled ? await shareAudio(audio) : true;
          if (!enabled) await stopSharingAudio();
          syncLocal();
          if (!audioShared) throw new ScreenAudioError();
        },
      },
    },
  };
}
