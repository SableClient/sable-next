<script lang="ts">
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import type { Component, Snippet } from 'svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { i18n } from '#lib/i18n.js';

  export type BannerTone = 'neutral' | 'warning';

  interface Props {
    icon: Component;
    title: Snippet;
    tone?: BannerTone;
    body: Snippet;
    actions: Snippet;
    onClose?: () => void;
  }

  let { icon: Icon, title, tone = 'neutral', body, actions, onClose }: Props = $props();
</script>

<div class={['banner', `banner-${tone}`]} role="status">
  <div class="description">
    <span class="icon">
      <IconContext values={{ 'aria-hidden': 'true' }}><Icon /></IconContext>
    </span>
    <div class="copy">
      <p class="title">{@render title()}</p>
      <div class="body">{@render body()}</div>
    </div>
    {#if onClose}
      <div class="close">
        <IconButton variant="ghost" size="small" label={$i18n.t('banner.close')} onclick={onClose}>
          <XIcon />
        </IconButton>
      </div>
    {/if}
  </div>
  <div class="actions">{@render actions()}</div>
</div>

<style>
  .banner {
    align-items: center;
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    display: grid;
    gap: var(--space-300) var(--space-200);
    grid-template-areas:
      'icon copy close'
      'actions actions actions';
    grid-template-columns: auto minmax(0, 1fr) auto;
    padding: var(--space-400);
    pointer-events: auto;
  }

  .banner-warning {
    border-color: var(--warn-container-line);
  }

  .description {
    display: contents;
  }

  .close {
    align-self: start;
    grid-area: close;
    translate: 0.25rem -0.25rem;
  }

  .icon {
    align-items: center;
    align-self: start;
    color: var(--surface-var-on-container);
    display: flex;
    grid-area: icon;
    height: var(--control-height-medium);
    justify-content: center;
    width: var(--control-height-medium);
  }

  .banner-warning .icon {
    color: var(--warn-on-container);
  }

  .icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .copy {
    grid-area: copy;
    min-width: 0;
  }

  .title {
    font-weight: var(--font-weight-medium);
    margin: 0;
  }

  .body {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-100) 0 0;
  }

  .actions {
    display: flex;
    gap: var(--space-300);
    grid-area: actions;
    justify-content: flex-end;
  }

  @media (width >= 42rem) {
    .banner {
      column-gap: var(--space-300);
      grid-template-areas: 'icon copy actions close';
      grid-template-columns: auto minmax(0, 1fr) auto auto;
    }
  }
</style>
