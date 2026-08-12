<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  type Props = {
    title: string;
    description?: string;
    eyebrow?: string;
    titleId?: string;
    class?: ClassValue;
    actions?: Snippet;
    children?: Snippet;
  };

  let {
    title,
    description,
    eyebrow,
    titleId = 'app-page-title',
    class: className = '',
    actions,
    children,
  }: Props = $props();
</script>

<svelte:head>
  <title>{title} - Sable</title>
</svelte:head>

<main class={['app-page-shell', className]}>
  <header class="app-page-header">
    <div>
      {#if eyebrow}<p class="app-page-eyebrow">{eyebrow}</p>{/if}
      <h1 id={titleId}>{title}</h1>
      {#if description}<p>{description}</p>{/if}
    </div>
    {#if actions}<div class="app-page-actions">{@render actions()}</div>{/if}
  </header>
  {@render children?.()}
</main>

<style>
  .app-page-shell {
    margin: 0 auto;
    max-width: 52rem;
    overflow: auto;
    padding: 2rem;
    width: 100%;
  }

  .app-page-header {
    margin-bottom: 2rem;
  }

  .app-page-header h1,
  .app-page-header p {
    margin-top: 0;
  }

  .app-page-header h1 {
    font-size: var(--font-size-xlarge);
  }

  .app-page-header p {
    color: var(--sable-surface-var-on-container);
  }

  .app-page-eyebrow {
    color: var(--sable-primary-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .app-page-header,
  .app-page-actions {
    align-items: center;
    display: flex;
    gap: 1rem;
    justify-content: space-between;
  }

  @media (width < 42rem) {
    .app-page-shell {
      padding: 1rem;
    }

    .app-page-header {
      align-items: stretch;
      flex-direction: column;
    }
  }
</style>
