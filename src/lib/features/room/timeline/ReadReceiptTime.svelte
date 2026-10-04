<script lang="ts">
  import { formatFullTimestamp, formatMessageTimestamp } from '#lib/ui/date-time.js';

  let { timestamp }: { timestamp?: number } = $props();
  let available = $derived(
    timestamp !== undefined && Number.isFinite(new Date(timestamp).getTime())
  );
</script>

{#if available && timestamp !== undefined}
  <time datetime={new Date(timestamp).toISOString()} title={formatFullTimestamp(timestamp)}>
    {formatMessageTimestamp(timestamp)}
  </time>
{/if}

<style>
  time {
    color: var(--surface-var-on-container);
    display: block;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }
</style>
