<script lang="ts">
  import { formatByteSize } from '#lib/ui/byte-size.js';
  import { formatDate } from '#lib/ui/date-time.js';

  interface Props {
    sender: string;
    timestamp: number;
    size?: number | null;
  }

  let { sender, timestamp, size = null }: Props = $props();
</script>

<span class="attachment-meta">
  {#if size !== null}
    <span>{formatByteSize(size)}</span>
  {/if}
  <span class="attachment-sender">{sender}</span>
  <span>{formatDate(timestamp)}</span>
</span>

<style>
  .attachment-meta {
    color: var(--surface-var-on-container);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: 0 var(--space-200);
    min-width: 0;
  }

  .attachment-sender {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
