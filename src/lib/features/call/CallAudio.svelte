<script lang="ts">
  import { untrack } from 'svelte';
  import { on } from 'svelte/events';
  import { RoomEvent, Track, type Participant, type RemoteTrack } from 'livekit-client';
  import type { Room as LivekitRoom } from 'livekit-client';
  import type { RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor';
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
  let playbackRoom = $derived(room);
  let node = $state<HTMLDivElement>();
  let audioElements = $state.raw<HTMLMediaElement[]>([]);

  type Filtered = {
    source: AudioNode;
    gain: GainNode;
    filter?: RnnoiseWorkletNode;
    live: boolean;
    off: () => void;
  };
  type Output = AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- audio graph bookkeeping, never rendered from
  const filtered = new Map<HTMLMediaElement, Filtered>();
  let amplifier: Output | undefined;
  let amplify: ((element: HTMLMediaElement) => void) | undefined;

  const levelOf = (element: HTMLMediaElement, muted: boolean, volume: number): void => {
    if (volume > 1 && !filtered.has(element)) amplify?.(element);
    const graph = filtered.get(element);
    if (graph?.live) graph.gain.gain.value = muted ? 0 : volume;
    else {
      element.muted = muted;
      element.volume = Math.min(volume, 1);
    }
  };

  const refresh = (element: HTMLMediaElement): void => {
    levelOf(
      element,
      deafened,
      volumeOf(element.dataset.identity ?? '', element.dataset.screen === 'true')
    );
  };

  $effect(() => {
    const currentNode = node;
    const currentTelemetry = telemetry;
    const currentRoom = playbackRoom;
    if (!currentRoom || !currentNode) return;

    const bank: VoiceFilterBank | undefined =
      preferences.incomingVoiceIsolation && supportsVoiceFilter()
        ? createVoiceFilterBank()
        : undefined;
    const routeToDevice = (context: Output, device: string, failure: string): void => {
      if (!context.setSinkId || !device) return;
      context.setSinkId(device).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'NotFoundError') {
          context.setSinkId?.('').catch(ignoreError);
          return;
        }
        currentTelemetry?.failure(failure, error);
      });
    };
    if (bank) {
      routeToDevice(
        bank.context as Output,
        preferences.audioOutputDevice,
        'call.audio.filter_output'
      );
    }

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- element bookkeeping, never rendered from
    const attached = new Map<
      string,
      { track: RemoteTrack; element: HTMLMediaElement; off: () => void }
    >();

    const route = (
      context: AudioContext,
      track: RemoteTrack,
      element: HTMLMediaElement,
      currentBank?: VoiceFilterBank
    ) => {
      const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const gain = context.createGain();
      const graph: Filtered = {
        source,
        gain,
        live: false,
        off: on(element, 'volumechange', () => {
          if (filtered.get(element) === graph && graph.live && !element.muted) element.muted = true;
        }),
      };
      source.connect(gain).connect(context.destination);
      filtered.set(element, graph);
      void context
        .resume()
        .then(() => {
          if (filtered.get(element) !== graph) return;
          graph.live = true;
          element.muted = true;
          refresh(element);
        })
        .catch(ignoreError);
      if (!currentBank) return;
      currentBank
        .create()
        .then((filter) => {
          if (filtered.get(element) !== graph) {
            filter.destroy();
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
      graph.off();
      graph.source.disconnect();
      graph.filter?.destroy();
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
        element.dataset.screen = String(screen);
        // livekit recycles audio elements across tracks, so a listener left behind would
        // fight the next call's listeners over `muted` and lock up the page (#1468).
        const off = on(element, 'volumechange', () => {
          if (!filtered.get(element)?.live) untrack(() => refresh(element));
        });
        attached.set(track.sid, { track, element, off });
        if (bank && !screen) route(bank.context, track, element, bank);
        levelOf(
          element,
          untrack(() => deafened),
          untrack(() => volumeOf(identity, screen))
        );
        currentNode.append(element);
        audioElements = [...untrack(() => audioElements), element];
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
        entry.off();
        unroute(entry.element);
        entry.element.remove();
        attached.delete(sid);
        audioElements = untrack(() => audioElements).filter((element) => element !== entry.element);
        currentTelemetry?.event('call.audio.track_detached', {
          'audio.attached_count': attached.size,
        });
      }
    };

    const openAmplifier = (): Output => {
      const context: Output = new AudioContext();
      routeToDevice(
        context,
        untrack(() => preferences.audioOutputDevice),
        'call.audio.amplifier_output'
      );
      return context;
    };

    amplify = (element) => {
      const entry = [...attached.values()].find((candidate) => candidate.element === element);
      if (entry) route(bank?.context ?? (amplifier ??= openAmplifier()), entry.track, element);
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
      void amplifier?.close().catch(ignoreError);
      amplifier = undefined;
      amplify = undefined;
    };
  });

  $effect(() => {
    const device = preferences.audioOutputDevice;
    amplifier?.setSinkId?.(device).catch(ignoreError);
  });

  $effect(() => {
    for (const element of audioElements) refresh(element);
  });
</script>

<div bind:this={node} class="audio" aria-hidden="true"></div>

<style>
  .audio {
    display: none;
  }
</style>
