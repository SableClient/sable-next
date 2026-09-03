<script lang="ts">
  import type { Component } from 'svelte';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';

  export interface SettingsNavEntry {
    id: string;
    label: string;
    icon: Component;
  }

  interface Props {
    entries: readonly SettingsNavEntry[];
    activeId: string | null;
    ariaLabel: string;
    onSelect: (event: MouseEvent, id: string) => void;
    href?: (entry: SettingsNavEntry) => string;
    showChevron?: boolean;
    large?: boolean;
  }

  let {
    entries,
    activeId,
    ariaLabel,
    onSelect,
    href,
    showChevron = false,
    large = false,
  }: Props = $props();
</script>

<nav class="sable-settings-nav-list" aria-label={ariaLabel}>
  {#each entries as entry (entry.id)}
    {@const active = activeId === entry.id}
    {@const Icon = entry.icon}
    {@const classes = [
      'sable-settings-nav-item',
      'sable-current',
      'sable-selection-layer',
      { 'sable-settings-nav-item-large': large },
    ]}
    {#if href}
      <a
        class={classes}
        href={href(entry)}
        aria-current={active ? 'page' : undefined}
        data-current={active ? 'true' : undefined}
        onclick={(event) => onSelect(event, entry.id)}
      >
        <span class="icon" aria-hidden="true"><Icon weight={active ? 'fill' : 'regular'} /></span>
        <span class="label">{entry.label}</span>
        {#if showChevron}<span class="chevron" aria-hidden="true"><CaretRightIcon /></span>{/if}
      </a>
    {:else}
      <button
        class={classes}
        type="button"
        aria-current={active ? 'page' : undefined}
        data-current={active ? 'true' : undefined}
        onclick={(event) => onSelect(event, entry.id)}
      >
        <span class="icon" aria-hidden="true"><Icon weight={active ? 'fill' : 'regular'} /></span>
        <span class="label">{entry.label}</span>
      </button>
    {/if}
  {/each}
</nav>

<style>
  .sable-settings-nav-list {
    align-content: start;
    display: grid;
    flex: 1;
    gap: var(--space-050);
    list-style: none;
    margin: 0;
    min-height: 0;
    min-width: 0;
    overflow: hidden auto;
    padding: var(--space-200);
    scrollbar-gutter: stable;
  }

  .sable-settings-nav-item {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    box-sizing: border-box;
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-500);
    gap: var(--space-300);
    line-height: var(--line-height-small);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-300);
    text-align: left;
    text-decoration: none;
    width: 100%;
  }

  .sable-settings-nav-item-large {
    min-height: var(--control-height-large);
  }

  .sable-settings-nav-item:hover {
    background: var(--sable-surface-container-hover);
  }

  .sable-settings-nav-item:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 2px;
  }

  .sable-settings-nav-item[aria-current='page'],
  .sable-settings-nav-item[data-current='true'] {
    background: var(--sable-surface-container-active);
    color: var(--sable-surface-on-container);
    font-weight: var(--font-weight-medium);
  }

  .sable-settings-nav-item[aria-current='page']:hover,
  .sable-settings-nav-item[data-current='true']:hover {
    background: var(--sable-surface-container-hover);
    color: var(--sable-surface-on-container);
  }

  .sable-settings-nav-item .icon {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    justify-content: center;
  }

  .sable-settings-nav-item .icon :global(svg),
  .sable-settings-nav-item .chevron :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .sable-settings-nav-item .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sable-settings-nav-item .chevron {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
  }
</style>
