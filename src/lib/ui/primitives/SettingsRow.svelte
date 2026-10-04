<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';
  import SettingsAnchorLink from './SettingsAnchorLink.svelte';
  import { settingsAnchors } from './settings-anchors.js';
  import StatusBadge from './StatusBadge.svelte';
  import './settings-row.css';

  interface Props {
    title?: string;
    description?: string | Snippet;
    disabled?: boolean;
    highlighted?: boolean;
    wide?: boolean;
    class?: ClassValue;
    id?: string;
    'data-settings-focus'?: string;
    control?: string;
    badge?: string;
    before?: Snippet;
    copy?: Snippet;
    children?: Snippet;
  }

  let {
    title,
    description,
    disabled = false,
    highlighted = false,
    wide = false,
    class: className = '',
    id,
    'data-settings-focus': dataSettingsFocus,
    control,
    badge,
    before,
    copy,
    children,
  }: Props = $props();
  const anchors = settingsAnchors();
  let lit = $derived(highlighted || (id !== undefined && anchors?.highlighted() === id));
</script>

<li
  {id}
  data-settings-focus={dataSettingsFocus}
  class={['setting-row', { disabled, highlighted: lit }, className]}
>
  {#if before}<span class="row-before">{@render before()}</span>{/if}
  <div class="row-copy">
    {#if copy}
      {@render copy()}
    {:else}
      <div class="row-name">
        {#if control}<label class="name" for={control}>{title}</label>
        {:else}<span class="name">{title}</span>{/if}
        {#if badge}<StatusBadge variant="neutral" label={badge} />{/if}
        {#if id}<SettingsAnchorLink anchor={id} />{/if}
      </div>
      {#if description}
        <p class="settings-description">
          {#if typeof description === 'string'}{description}{:else}{@render description()}{/if}
        </p>
      {/if}
    {/if}
  </div>
  <div class={['row-control', { wide }]}>{@render children?.()}</div>
</li>

<style>
  .setting-row {
    align-items: center;
    box-sizing: border-box;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100) var(--space-400);
    min-height: var(--target-hit);
    padding: var(--space-150) var(--space-400);

    :global(img),
    :global(.media-image) {
      max-height: var(--space-900);
      max-width: var(--space-900);
    }
  }

  :global(.setting-row + .setting-row) {
    box-shadow: inset 0 var(--border-width) 0 var(--bg-container-line);
  }

  .row-before {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
  }

  .row-copy {
    flex: 1 1 0;
    min-width: min(var(--space-1100), 100%);
    position: relative;
  }

  .row-name :global(.anchor-link) {
    position: relative;
  }

  .row-name {
    align-items: center;
    display: flex;
    flex-wrap: nowrap;
    gap: var(--space-200);
  }

  .name {
    font-weight: var(--font-weight-medium);
    overflow-wrap: anywhere;
  }

  .setting-row.disabled .row-copy {
    opacity: var(--opacity-secondary);
  }

  .setting-row.highlighted {
    background: var(--primary-container);
    color: var(--primary-on-container);
  }

  @media (prefers-reduced-motion: no-preference) {
    .setting-row {
      transition: background-color var(--motion-slow) var(--motion-easing-standard);
    }
  }

  .row-control {
    align-items: center;
    display: flex;
    flex: 0 1 auto;
    flex-wrap: wrap;
    gap: var(--space-300);
    justify-content: flex-end;
    max-width: 100%;
    min-height: var(--target-hit);
    min-width: 0;
    width: auto;
  }

  .row-control:not(.wide) {
    flex: 0 0 auto;
  }

  .row-control :global(.select) {
    min-width: min(11rem, 100%);
  }
</style>
