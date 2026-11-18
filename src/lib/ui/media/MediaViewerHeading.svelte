<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    sender: string;
    position: number;
    total: number;
    label: string;
  }

  let { sender, position, total, label }: Props = $props();
</script>

<div class="heading">
  <strong>{sender}</strong>
  <Tooltip {label}>
    {#snippet trigger({ props })}
      <span {...props}>{i18n.t('viewer.position', { index: position, total })} · {label}</span>
    {/snippet}
  </Tooltip>
</div>

<style>
  .heading {
    display: grid;
    flex: 1;
    gap: var(--space-050);
    min-width: 0;
  }

  .heading strong,
  .heading span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .heading span {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
