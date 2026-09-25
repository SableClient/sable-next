<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';
  import SettingsAnchorLink from './SettingsAnchorLink.svelte';
  import { settingsAnchors } from './settings-anchors.js';
  import StatusBadge from './StatusBadge.svelte';

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
    {#if control}<label class="row-hit" for={control}></label>{/if}
    {#if copy}
      {@render copy()}
    {:else}
      <div class="row-name">
        <span class="name">{title}</span>
        {#if badge}<StatusBadge variant="neutral" label={badge} />{/if}
        {#if id}<SettingsAnchorLink anchor={id} />{/if}
      </div>
      {#if typeof description === 'string'}<p>{description}</p>
      {:else if description}
        <p>
          {@render description()}
        </p>
      {/if}
    {/if}
  </div>
  <div class={['row-control', { wide }]}>{@render children?.()}</div>
</li>

<style>
  .setting-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-400);
    min-height: calc(var(--control-height-medium) + var(--space-300));
    padding: var(--space-300) var(--space-400);

    :global(img),
    :global(.media-image) {
      max-height: var(--space-900);
      max-width: var(--space-900);
    }
  }

  :global(.setting-row + .setting-row) {
    border-top: var(--border-width) solid var(--bg-container-line);
  }

  .row-before {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
  }

  .row-copy {
    flex: 1 1 12rem;
    min-width: 0;
    position: relative;
  }

  .row-hit {
    cursor: pointer;
    inset: 0;
    position: absolute;
  }

  .row-name :global(.anchor-link) {
    position: relative;
  }

  .row-name {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .name {
    font-weight: var(--font-weight-medium);
    overflow-wrap: anywhere;
  }

  .row-copy p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-100) 0 0;
    max-width: 60ch;
    overflow-wrap: anywhere;
  }

  .setting-row.disabled .row-copy {
    opacity: 0.65;
  }

  .setting-row.highlighted {
    background: var(--primary-container);
  }

  @media (prefers-reduced-motion: no-preference) {
    .setting-row {
      transition: background-color var(--motion-slow) var(--motion-easing-standard);
    }
  }

  .row-control {
    align-items: center;
    display: flex;
    flex: 1 1 100%;
    flex-wrap: wrap;
    gap: var(--space-300);
    justify-content: flex-start;
    max-width: 100%;
    min-width: 0;
    width: auto;
  }

  .row-control:not(.wide) {
    flex: 0 0 auto;
  }

  .row-control.wide {
    min-width: 11rem;
  }

  .row-control :global(.select) {
    min-width: min(11rem, 100%);
  }

  @media (width >= 42rem) {
    .setting-row {
      flex-wrap: nowrap;
    }

    .row-control {
      flex: 0 0 auto;
      justify-content: flex-end;
      padding-left: 0;
      width: auto;
    }
  }
</style>
