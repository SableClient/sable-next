<script lang="ts">
  import type { Component } from 'svelte';
  import type { ClassValue, HTMLButtonAttributes } from 'svelte/elements';
  import ArrowRightIcon from 'phosphor-svelte/lib/ArrowRightIcon';

  interface Props {
    icon: Component;
    title: string;
    description?: string;
    href?: string;
    disabled?: boolean;
    onclick?: HTMLButtonAttributes['onclick'];
    class?: ClassValue;
  }

  let {
    icon: Icon,
    title,
    description,
    href,
    disabled = false,
    onclick,
    class: className = '',
  }: Props = $props();

  let inactive = $derived(disabled || (!href && !onclick));
</script>

{#if href}
  <!-- eslint-disable svelte/no-navigation-without-resolve -- href is resolved by the caller -->
  <a
    class={['action-card', { 'action-card-disabled': inactive }, className]}
    href={inactive ? undefined : href}
    aria-disabled={inactive ? 'true' : undefined}
  >
    <span class="action-card-icon" aria-hidden="true"><Icon /></span>
    <span class="action-card-copy">
      <span class="action-card-title">{title}</span>
      {#if description}<span class="action-card-description">{description}</span>{/if}
    </span>
    <span class="action-card-arrow" aria-hidden="true"><ArrowRightIcon /></span>
  </a>
  <!-- eslint-enable svelte/no-navigation-without-resolve -->
{:else}
  <button
    class={['action-card', { 'action-card-disabled': inactive }, className]}
    type="button"
    disabled={inactive}
    {onclick}
  >
    <span class="action-card-icon" aria-hidden="true"><Icon /></span>
    <span class="action-card-copy">
      <span class="action-card-title">{title}</span>
      {#if description}<span class="action-card-description">{description}</span>{/if}
    </span>
    <span class="action-card-arrow" aria-hidden="true"><ArrowRightIcon /></span>
  </button>
{/if}

<style>
  .action-card {
    align-items: flex-start;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-sizing: border-box;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    font: inherit;
    gap: var(--space-2);
    min-height: 12rem;
    min-width: 0;
    padding: var(--space-3);
    position: relative;
    text-align: left;
    text-decoration: none;
    transition:
      background-color var(--motion-normal) ease,
      border-color var(--motion-normal) ease,
      transform var(--motion-normal) ease;
    width: 100%;
  }

  .action-card:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .action-card:hover:not(.action-card-disabled) {
    background: var(--sable-bg-container-hover);
    border-color: var(--sable-primary-container-line);
    transform: translateY(-2px);
  }

  .action-card-disabled {
    cursor: default;
    opacity: 0.7;
  }

  .action-card-icon {
    align-items: center;
    color: var(--sable-primary-main);
    display: inline-flex;
    flex: 0 0 auto;
    height: var(--icon-size-medium);
    justify-content: center;
    width: var(--icon-size-medium);
  }

  .action-card-icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .action-card-copy {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    padding-right: var(--space-3);
  }

  .action-card-title {
    font-size: var(--font-size-large);
    font-weight: var(--font-weight-bold);
  }

  .action-card-description {
    color: var(--sable-surface-var-on-container);
    line-height: var(--line-height-body);
  }

  .action-card-arrow {
    align-items: center;
    bottom: var(--space-3);
    color: var(--sable-primary-main);
    display: inline-flex;
    height: var(--icon-size-small);
    justify-content: center;
    position: absolute;
    right: var(--space-3);
    width: var(--icon-size-small);
  }

  .action-card-arrow :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  @media (width < 48rem) {
    .action-card {
      min-height: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .action-card {
      transition: none;
    }
  }
</style>
