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
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    display: flex;
    flex-flow: column wrap;
    gap: var(--space-400);
    padding: var(--space-400);
  }

  .banner-warning {
    border-color: var(--warn-container-line);
  }

  .description {
    display: flex;
    flex-grow: 1;
    gap: var(--space-200);
    width: 100%;
  }

  .close {
    flex-grow: 0;
    translate: 0.25rem -0.25rem;
  }

  .icon {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    flex-grow: 0;
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
    flex-grow: 1;
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
    flex: 0 0 auto;
    gap: var(--space-300);
    justify-content: flex-end;
    pointer-events: auto;
    width: 100%;
  }

  @media (width >= 42rem) {
    .banner {
      flex-wrap: nowrap;
    }

    .actions {
      justify-content: right;
    }
  }
</style>
