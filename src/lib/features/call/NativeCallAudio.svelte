<script lang="ts">
  /* eslint-disable svelte/prefer-svelte-reactivity */
  import { onDestroy } from 'svelte';
  import type { CallParticipant } from './call-transport';
  import { ignoreError } from './call-transport';

  interface Props {
    participants: readonly CallParticipant[];
    deafened: boolean;
    volumeOf: (identity: string, screen: boolean) => number;
    setVolume: (identity: string, volume: number, screen: boolean) => Promise<void>;
  }

  let { participants, deafened, volumeOf, setVolume }: Props = $props();

  const levels = new Map<string, number>();
  let pending = Promise.resolve();
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
  });

  $effect(() => {
    const current = new Set<string>();
    for (const participant of participants) {
      for (const screen of [false, true]) {
        const track = screen ? participant.screenShareAudio : participant.microphone;
        if (!track) continue;
        const key = JSON.stringify([participant.identity, screen, track.id]);
        current.add(key);
        const volume = deafened ? 0 : volumeOf(participant.identity, screen);
        if (levels.get(key) === volume) continue;
        levels.set(key, volume);
        const apply = setVolume;
        pending = pending
          .then(() => (destroyed ? undefined : apply(participant.identity, volume, screen)))
          .catch((error: unknown) => {
            if (levels.get(key) === volume) levels.delete(key);
            ignoreError(error);
          });
      }
    }
    for (const key of levels.keys()) {
      if (!current.has(key)) levels.delete(key);
    }
  });
</script>
