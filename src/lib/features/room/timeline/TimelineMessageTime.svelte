<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { formatFullTimestamp } from '#lib/ui/date-time.js';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    timestamp: number;
    pending: boolean;
    format: (timestamp: number) => string;
  }

  let { timestamp, pending, format }: Props = $props();
</script>

{#if pending}
  <Spinner small label={i18n.t('timeline.sending')} />
{:else}
  <Tooltip>
    {#snippet content()}{formatFullTimestamp(timestamp)}{/snippet}
    {#snippet trigger({ props })}
      <time {...props} datetime={new Date(timestamp).toISOString()}>
        {format(timestamp)}
      </time>
    {/snippet}
  </Tooltip>
{/if}

<style>
  time {
    color: var(--surface-var-on-container);
  }
</style>
