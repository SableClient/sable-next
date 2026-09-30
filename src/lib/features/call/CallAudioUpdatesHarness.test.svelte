<script lang="ts">
  import CallAudio from './CallAudio.svelte';
  import type { Room } from 'livekit-client';

  let { room }: { room: Room } = $props();
  let revision = $state(0);
  let rooms = $derived.by(() => {
    void revision;
    return [{ backendId: 'backend', room }];
  });
</script>

<button type="button" onclick={() => (revision += 1)}>update participants</button>
{#each rooms as entry (entry.backendId)}
  <CallAudio room={entry.room} />
{/each}
