<script lang="ts">
  import { Dialog } from 'bits-ui';

  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';

  interface Props {
    modal?: boolean;
    class?: ClassValue;
    prefix?: Snippet;
    main?: Snippet;
    suffix?: Snippet;
    title?: string;
    subtitle?: string;
  }

  let {
    modal = false,
    class: className = '',
    prefix,
    main,
    suffix,
    title = '',
    subtitle = '',
  }: Props = $props();
</script>

<header class={['panel-header', className]}>
  {#if prefix}
    <div class="prefix">{@render prefix()}</div>
  {/if}
  <div class={['main', main || 'no-custom-content', !main && subtitle && 'has-subtitle']}>
    {#if main}
      {@render main()}
    {:else if title}
      {#if modal}
        <Dialog.Title class="title">{title}</Dialog.Title>
      {:else}
        <h2 class="title">{title}</h2>
      {/if}
      {#if subtitle}<p class="subtitle">{subtitle}</p>{/if}
    {/if}
  </div>
  {#if suffix}
    <div class="suffix">{@render suffix()}</div>
  {/if}
</header>

<style>
  .panel-header {
    align-items: center;
    background: inherit;
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-300);
    min-height: calc(var(--header-height) + var(--edge-inset-top));
    padding: var(--edge-inset-top) var(--page-gutter) 0;
  }

  .prefix,
  .main,
  .suffix {
    align-items: center;
    display: flex;
    gap: var(--space-150);
  }

  .prefix,
  .suffix {
    flex: 0 0 auto;
  }

  .main {
    flex: 1;
  }

  .prefix :global(> .icon-button),
  .suffix :global(> .icon-button) {
    flex: 0 0 auto;
  }

  .main.no-custom-content {
    display: grid;
    gap: 0;
    min-width: 0;
  }

  /* :global is needed to match Dialog.Title */
  .main.no-custom-content > :global(.title) {
    font-size: var(--font-size-heading);
    font-weight: bold;
    line-height: var(--line-height-heading);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .main.no-custom-content.has-subtitle > :global(.title) {
    font-size: var(--font-size-body);
  }

  .main.no-custom-content > .subtitle {
    color: var(--surface-var-on-container);
    font: var(--font-size-body);
    font-size: var(--font-size-small);
    font-weight: normal;
    line-height: var(--line-height-small);
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
