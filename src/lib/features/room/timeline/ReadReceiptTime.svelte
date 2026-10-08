<script lang="ts">
  import { formatFullTimestamp, formatMessageTimestamp } from '#lib/ui/date-time.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  let { timestamp }: { timestamp?: number } = $props();
  let available = $derived(
    timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime())
  );
</script>

{#if available && timestamp !== undefined}
  {@const fullTimestamp = formatFullTimestamp(timestamp)}
  <Tooltip label={fullTimestamp}>
    {#snippet trigger({ props })}
      <time {...props} datetime={new Date(timestamp).toISOString()}>
        {formatMessageTimestamp(timestamp)}
      </time>
    {/snippet}
  </Tooltip>
{/if}

<style>
  time {
    color: var(--surface-var-on-container);
    display: block;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }
</style>
