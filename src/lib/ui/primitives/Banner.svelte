<script lang="ts">
  import type { Component, Snippet } from 'svelte';

  export type BannerTone = 'neutral' | 'warning';

  interface Props {
    icon: Component;
    title: string;
    tone?: BannerTone;
    body: Snippet;
    actions: Snippet;
  }

  let { icon: Icon, title, tone = 'neutral', body, actions }: Props = $props();
</script>

<aside class={['banner', `banner-${tone}`]} role="status" aria-label={title}>
  <span class="icon"><Icon /></span>
  <div class="copy">
    <p class="title">{title}</p>
    <div class="body">{@render body()}</div>
  </div>
  <div class="actions">{@render actions()}</div>
</aside>

<style>
  .banner {
    align-items: center;
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    padding: var(--space-3);
  }

  .banner-warning {
    border-color: var(--sable-warn-container-line);
  }

  .icon {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
    height: var(--control-height-medium);
    justify-content: center;
    width: var(--control-height-medium);
  }

  .banner-warning .icon {
    background: var(--sable-warn-container);
    color: var(--sable-warn-on-container);
  }

  .icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .copy {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-weight: var(--font-weight-medium);
    margin: 0;
  }

  .body {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: calc(var(--space-1) / 2) 0 0;
  }

  .actions {
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-2);
    justify-content: flex-end;
    width: 100%;
  }

  @media (width >= 42rem) {
    .banner {
      flex-wrap: nowrap;
    }

    .actions {
      justify-content: normal;
      width: auto;
    }
  }
</style>
