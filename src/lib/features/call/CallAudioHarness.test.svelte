<script lang="ts">
  import CallAudio from './CallAudio.svelte';
  import type { Room } from 'livekit-client';

  let { first, second }: { first: Room; second: Room } = $props();
  let useSecond = $state(false);
</script>

<button type="button" onclick={() => (useSecond = true)}>replace</button>
<CallAudio room={useSecond ? second : first} />
