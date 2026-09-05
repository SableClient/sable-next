<script lang="ts">
  import type { Component, Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';
  import StatusBadge from './StatusBadge.svelte';

  type TitleAction = {
    label: string;
    icon: Component;
    onclick: () => void;
  };

  interface Props {
    title: string;
    description?: string;
    icon?: Component;
    disabled?: boolean;
    highlighted?: boolean;
    wide?: boolean;
    class?: ClassValue;
    id?: string;
    'data-settings-focus'?: string;
    badge?: string;
    titleAction?: TitleAction;
    before?: Snippet;
    children?: Snippet;
  }

  let {
    title,
    description,
    icon: Icon,
    disabled = false,
    highlighted = false,
    wide = false,
    class: className = '',
    id,
    'data-settings-focus': dataSettingsFocus,
    badge,
    titleAction,
    before,
    children,
  }: Props = $props();
</script>

<li
  {id}
  data-settings-focus={dataSettingsFocus}
  class={['setting-row', { disabled, highlighted }, className]}
>
  {#if before}<span class="row-before">{@render before()}</span>{/if}
  {#if Icon}<span class="row-icon" aria-hidden="true"><Icon /></span>{/if}
  <div class="row-copy">
    <div class="row-name">
      <span class="name">{title}</span>
      {#if badge}<StatusBadge variant="neutral" label={badge} />{/if}
      {#if titleAction}
        <span class="row-share">
          <button type="button" aria-label={titleAction.label} onclick={titleAction.onclick}>
            <titleAction.icon />
          </button>
        </span>
      {/if}
    </div>
    {#if description}<p>{description}</p>{/if}
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

    img {
        max-height: var(--space-900);
      }
  }

  :global(.setting-row + .setting-row) {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
  }

  .row-before {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
  }

  .row-icon {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
    height: var(--control-height-small);
    justify-content: center;
    width: var(--control-height-small);
  }

  .row-icon :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .row-copy {
    flex: 1;
    min-width: 0;
  }

  .row-name {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .name {
    font-weight: var(--font-weight-medium);
  }

  .row-copy p {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-100) 0 0;
    max-width: 60ch;
  }

  .setting-row.disabled .row-icon,
  .setting-row.disabled .row-copy {
    opacity: 0.65;
  }

  .setting-row.highlighted {
    background: var(--sable-primary-container);
  }

  @media (prefers-reduced-motion: no-preference) {
    .setting-row {
      transition: background-color var(--motion-slow) var(--motion-easing-standard);
    }
  }

  .row-share {
    display: inline-flex;
    flex: 0 0 auto;
  }

  .row-share button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    height: var(--icon-size-large);
    justify-content: center;
    padding: 0;
    width: var(--icon-size-large);
  }

  .row-share button:hover {
    background: var(--sable-surface-container-hover);
  }

  .row-share button:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .row-share :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .row-control {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-start;
    padding-left: calc(var(--control-height-small) + var(--space-400));
    width: 100%;
  }

  .row-control.wide {
    min-width: 11rem;
  }

  @media (hover: hover) {
    .row-share {
      opacity: 0;
    }

    .setting-row:hover .row-share,
    .setting-row:focus-within .row-share {
      opacity: 1;
    }
  }

  @media (width >= 42rem) {
    .setting-row {
      flex-wrap: nowrap;
    }

    .row-control {
      justify-content: flex-end;
      padding-left: 0;
      width: auto;
    }
  }
</style>
