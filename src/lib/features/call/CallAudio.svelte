<script lang="ts">
  import { RoomEvent, Track, type RemoteTrack } from 'livekit-client';
  import type { Room as LivekitRoom } from 'livekit-client';
  import type { CallTelemetry } from './call-telemetry';

  interface Props {
    room: LivekitRoom | undefined;
    telemetry?: Pick<CallTelemetry, 'event' | 'failure'>;
  }

  let { room, telemetry }: Props = $props();
  let node = $state<HTMLDivElement>();

  $effect(() => {
    const currentNode = node;
    const currentTelemetry = telemetry;
    const currentRoom = room;
    if (!currentRoom || !currentNode) return;

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- element bookkeeping, never rendered from
    const attached = new Map<string, { track: RemoteTrack; element: HTMLMediaElement }>();

    const recordPlaybackStatus = (): void => {
      currentTelemetry?.event('call.audio.playback_status', {
        'audio.playback_allowed': currentRoom.canPlaybackAudio,
      });
    };

    const attach = (track: RemoteTrack): void => {
      if (track.kind !== Track.Kind.Audio || !track.sid || attached.has(track.sid)) return;
      try {
        const element = track.attach();
        element.autoplay = true;
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
        entry.element.remove();
        attached.delete(sid);
        currentTelemetry?.event('call.audio.track_detached', {
          'audio.attached_count': attached.size,
        });
      }
    };

    for (const participant of currentRoom.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.track) attach(publication.track);
      }
    }
    currentRoom
      .on(RoomEvent.TrackSubscribed, attach)
      .on(RoomEvent.TrackUnsubscribed, detach)
      .on(RoomEvent.AudioPlaybackStatusChanged, recordPlaybackStatus);
    recordPlaybackStatus();

    return () => {
      currentRoom
        .off(RoomEvent.TrackSubscribed, attach)
        .off(RoomEvent.TrackUnsubscribed, detach)
        .off(RoomEvent.AudioPlaybackStatusChanged, recordPlaybackStatus);
      for (const sid of [...attached.keys()]) release(sid);
    };
  });
</script>

<div bind:this={node} class="audio" aria-hidden="true"></div>

<style>
  .audio {
    display: none;
  }
</style>
