<script lang="ts">
  import { RoomEvent, Track, type RemoteTrack } from 'livekit-client';
  import type { Room as LivekitRoom } from 'livekit-client';

  interface Props {
    room: LivekitRoom | undefined;
  }

  let { room }: Props = $props();

  function mixAudio(node: HTMLDivElement) {
    if (!room) return;

    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- element bookkeeping, never rendered from
    const attached = new Map<string, { track: RemoteTrack; element: HTMLMediaElement }>();

    const attach = (track: RemoteTrack): void => {
      if (track.kind !== Track.Kind.Audio || !track.sid || attached.has(track.sid)) return;
      const element = track.attach();
      element.autoplay = true;
      node.append(element);
      attached.set(track.sid, { track, element });
    };

    const detach = (track: RemoteTrack): void => {
      if (!track.sid) return;
      release(track.sid);
    };

    const release = (sid: string): void => {
      const entry = attached.get(sid);
      if (!entry) return;
      entry.track.detach(entry.element);
      entry.element.remove();
      attached.delete(sid);
    };

    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        if (publication.track) attach(publication.track);
      }
    }

    room.on(RoomEvent.TrackSubscribed, attach).on(RoomEvent.TrackUnsubscribed, detach);

    return () => {
      room.off(RoomEvent.TrackSubscribed, attach).off(RoomEvent.TrackUnsubscribed, detach);
      for (const sid of [...attached.keys()]) release(sid);
    };
  }
</script>

<div class="audio" aria-hidden="true" {@attach mixAudio}></div>

<style>
  .audio {
    display: none;
  }
</style>
