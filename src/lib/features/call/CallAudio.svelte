<script lang="ts">
  import { untrack } from 'svelte';
  import { RoomEvent, Track, type Participant, type RemoteTrack } from 'livekit-client';
  import type { Room as LivekitRoom } from 'livekit-client';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import type { CallTelemetry } from './call-telemetry';
  import { ignoreError } from './call-transport';
  import { createVoiceFilterBank, supportsVoiceFilter, type VoiceFilterBank } from './voice-filter';

  interface Props {
    room: LivekitRoom | undefined;
    telemetry?: Pick<CallTelemetry, 'event' | 'failure'>;
    deafened?: boolean;
    volumeOf?: (identity: string, screen: boolean) => number;
  }

  let { room, telemetry, deafened = false, volumeOf = () => 1 }: Props = $props();
  let node = $state<HTMLDivElement>();

  type Filtered = { source: AudioNode; gain: GainNode; filter?: AudioWorkletNode };

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- audio graph bookkeeping, never rendered from
  const filtered = new Map<HTMLMediaElement, Filtered>();

  const levelOf = (element: HTMLMediaElement, muted: boolean, volume: number): void => {
    const graph = filtered.get(element);
    if (graph) graph.gain.gain.value = muted ? 0 : volume;
    else {
      element.muted = muted;
      element.volume = volume;
    }
  };

  $effect(() => {
    const currentNode = node;
    const currentTelemetry = telemetry;
    const currentRoom = room;
    if (!currentRoom || !currentNode) return;

    const bank: VoiceFilterBank | undefined =
      preferences.incomingVoiceIsolation && supportsVoiceFilter()
        ? createVoiceFilterBank()
        : undefined;
    const output = bank?.context as
      | (AudioContext & { setSinkId?: (deviceId: string) => Promise<void> })
      | undefined;
    const outputDevice = bank ? preferences.audioOutputDevice : '';
    if (output?.setSinkId && outputDevice) {
      output.setSinkId(outputDevice).catch((error: unknown) => {
        currentTelemetry?.failure('call.audio.filter_output', error);
      });
    }

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- element bookkeeping, never rendered from
    const attached = new Map<string, { track: RemoteTrack; element: HTMLMediaElement }>();

    const route = (currentBank: VoiceFilterBank, track: RemoteTrack, element: HTMLMediaElement) => {
      const { context } = currentBank;
      const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const gain = context.createGain();
      const graph: Filtered = { source, gain };
      source.connect(gain).connect(context.destination);
      filtered.set(element, graph);
      void context.resume().catch(ignoreError);
      currentBank
        .create()
        .then((filter) => {
          if (filtered.get(element) !== graph) {
            filter.disconnect();
            return;
          }
          source.disconnect();
          source.connect(filter).connect(gain);
          graph.filter = filter;
        })
        .catch((error: unknown) => currentTelemetry?.failure('call.audio.filter', error));
    };

    const unroute = (element: HTMLMediaElement): void => {
      const graph = filtered.get(element);
      if (!graph) return;
      filtered.delete(element);
      graph.source.disconnect();
      graph.filter?.disconnect();
      graph.gain.disconnect();
    };

    const recordPlaybackStatus = (): void => {
      currentTelemetry?.event('call.audio.playback_status', {
        'audio.playback_allowed': currentRoom.canPlaybackAudio,
      });
    };

    const attach = (track: RemoteTrack, identity: string): void => {
      if (track.kind !== Track.Kind.Audio || !track.sid || attached.has(track.sid)) return;
      try {
        const element = track.attach();
        element.autoplay = true;
        element.dataset.identity = identity;
        const screen = track.source === Track.Source.ScreenShareAudio;
        if (screen) element.dataset.screen = 'true';
        if (bank && !screen) {
          element.muted = true;
          route(bank, track, element);
        }
        levelOf(
          element,
          untrack(() => deafened),
          untrack(() => volumeOf(identity, screen))
        );
        currentNode.append(element);
        attached.set(track.sid, { track, element });
        currentTelemetry?.event('call.audio.track_attached', {
          'audio.attached_count': attached.size,
        });
      } catch (error) {
        currentTelemetry?.failure('call.audio.track_attach', error);
      }
    };

    const detach = (track: RemoteTrack): void => {
      if (!track.sid) return;
      release(track.sid);
    };

    const release = (sid: string): void => {
      const entry = attached.get(sid);
      if (!entry) return;
      try {
        entry.track.detach(entry.element);
      } catch (error) {
        currentTelemetry?.failure('call.audio.track_detach', error);
      } finally {
        unroute(entry.element);
        entry.element.remove();
        attached.delete(sid);
        currentTelemetry?.event('call.audio.track_detached', {
          'audio.attached_count': attached.size,
        });
      }
    };

    const onSubscribed = (track: RemoteTrack, _publication: unknown, participant: Participant) =>
      attach(track, participant.identity);

    for (const participant of currentRoom.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.track) attach(publication.track, participant.identity);
      }
    }
    currentRoom
      .on(RoomEvent.TrackSubscribed, onSubscribed)
      .on(RoomEvent.TrackUnsubscribed, detach)
      .on(RoomEvent.AudioPlaybackStatusChanged, recordPlaybackStatus);
    recordPlaybackStatus();

    return () => {
      currentRoom
        .off(RoomEvent.TrackSubscribed, onSubscribed)
        .off(RoomEvent.TrackUnsubscribed, detach)
        .off(RoomEvent.AudioPlaybackStatusChanged, recordPlaybackStatus);
      for (const sid of [...attached.keys()]) release(sid);
      bank?.close();
    };
  });

  $effect(() => {
    const currentNode = node;
    const muted = deafened;
    if (!currentNode) return;

    for (const element of currentNode.children) {
      if (element instanceof HTMLMediaElement)
        levelOf(
          element,
          muted,
          untrack(() => volumeOf(element.dataset.identity ?? '', element.dataset.screen === 'true'))
        );
    }
  });

  $effect(() => {
    const currentNode = node;
    const volume = volumeOf;
    if (!currentNode) return;

    for (const element of currentNode.children) {
      if (element instanceof HTMLMediaElement)
        levelOf(
          element,
          untrack(() => deafened),
          volume(element.dataset.identity ?? '', element.dataset.screen === 'true')
        );
    }
  });
</script>

<div bind:this={node} class="audio" aria-hidden="true"></div>

<style>
  .audio {
    display: none;
  }
</style>
