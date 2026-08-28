<script lang="ts">
  import { debugLog } from './debug-log.svelte.js';

  let { warn }: { warn: () => void } = $props();
</script>

{#each debugLog.entries.slice(-200).toReversed() as entry (entry.id)}
  <details>{warn()}{entry.message}</details>
{/each}
