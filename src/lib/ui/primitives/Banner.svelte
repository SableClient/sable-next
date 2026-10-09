<script lang="ts">
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import type { Component, Snippet } from 'svelte';

  export type BannerTone = 'neutral' | 'warning';

  interface Props {
    icon: Component;
    title: Snippet;
    tone?: BannerTone;
    body: Snippet;
    actions: Snippet;
  }

  let { icon: Icon, title, tone = 'neutral', body, actions }: Props = $props();
</script>

<div class={['banner', `banner-${tone}`]} role="status">
  <div class="description">
    <span class="icon">
      <IconContext values={{ 'aria-hidden': 'true' }}><Icon /></IconContext>
    </span>
    <p class="title">{@render title()}</p>
    <div class="body">{@render body()}</div>
  </div>
  <div class="actions">{@render actions()}</div>
</div>

<style>
  .banner {
    align-items: center;
    background: var(--sec-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    color: var(--surface-on-container);
    display: grid;
    gap: var(--space-100) var(--space-200);
    grid-template-areas:
      'icon title'
      '. body'
      'actions actions';
    grid-template-columns: auto minmax(0, 1fr);
    padding: var(--space-200);
    pointer-events: auto;
  }

  .banner-warning {
    border-color: var(--warn-container-line);
  }

  .description {
    display: contents;
  }

  .icon {
    align-items: center;
    align-self: start;
    color: var(--surface-on-container);
    display: flex;
    grid-area: icon;
    height: var(--control-height-medium);
    justify-content: center;
    width: var(--control-height-medium);
  }

  .banner-warning .icon {
    color: var(--warn-main);
  }

  .icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .title {
    font-weight: var(--font-weight-medium);
    grid-area: title;
    margin: 0;
  }

  .body {
    align-self: start;
    color: var(--surface-on-container);
    font-size: var(--font-size-small);
    grid-area: body;
    margin: 0 0 var(--space-100) 0;
  }

  .actions {
    display: flex;
    gap: var(--space-300);
    grid-area: actions;
    justify-content: flex-end;
  }
</style>
