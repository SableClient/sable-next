<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';

  interface Props {
    direction: 'previous' | 'next';
    onclick: () => void;
  }

  let { direction, onclick }: Props = $props();
</script>

<IconButton
  class={`nav ${direction}`}
  label={i18n.t(direction === 'previous' ? 'viewer.previous' : 'viewer.next')}
  size="large"
  {onclick}
  >{#if direction === 'previous'}<ArrowLeftIcon />{:else}<ArrowRightIcon />{/if}</IconButton
>

<style>
  :global(.nav) {
    background: var(--surface-container-hover);
    color: var(--surface-on-container);
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.nav) {
      transition:
        opacity var(--motion-normal) var(--ease-smooth-out),
        visibility var(--motion-normal);
    }
  }

  :global(.nav:hover) {
    background: var(--surface-container-active);
  }

  :global(.previous) {
    left: max(0.25rem, var(--safe-left));
  }

  :global(.next) {
    right: max(0.25rem, var(--safe-right));
  }

  @media (--compact-layout) {
    :global(.nav) {
      display: none;
    }
  }

  @media (--app-layout) {
    :global(.previous) {
      left: 1.5rem;
    }

    :global(.next) {
      right: 1.5rem;
    }
  }
</style>
