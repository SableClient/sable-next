<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import CopySimpleIcon from 'phosphor-svelte/lib/CopySimpleIcon';

  import { i18n } from '#lib/i18n.js';
  import { Copied } from '#lib/ui/copied.svelte.js';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  interface Props {
    value: string;
    mono?: boolean;
  }

  let { value, mono = true }: Props = $props();
  const copied = new Copied();
</script>

<Tooltip label={i18n.t(copied.value ? 'common.copied' : 'common.copy')}>
  {#snippet trigger({ props })}
    <button
      {...props}
      type="button"
      class={['copy-value', { mono }]}
      onclick={() => void copied.copy(value)}
    >
      <span class="text">{value}</span>
      <span class={['icon', { shown: copied.value }]} aria-hidden="true">
        {#if copied.value}<CheckIcon size="1em" />{:else}<CopySimpleIcon size="1em" />{/if}
      </span>
    </button>
  {/snippet}
</Tooltip>

<style>
  .copy-value {
    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius-inner);
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    gap: var(--space-100);
    margin: 0;
    max-width: 100%;
    padding: 0;
    text-align: inherit;
  }

  .copy-value.mono {
    font-family: var(--font-family-mono);
    font-variant-ligatures: none;
  }

  .text {
    overflow-wrap: anywhere;
    user-select: text;
  }

  .icon {
    color: var(--surface-var-on-container);
    display: inline-flex;
    flex: none;
    opacity: 0;
    transition: opacity var(--duration-fast) ease-out;
  }

  .copy-value:hover .icon,
  .copy-value:focus-visible .icon,
  .icon.shown {
    opacity: 1;
  }

  .copy-value:hover .text {
    color: var(--primary-main);
  }

  .copy-value:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--space-050);
  }

  @media (pointer: coarse) {
    .icon {
      opacity: 1;
    }
  }
</style>
