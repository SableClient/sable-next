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
    density?: 'default' | 'compact';
  };

  const uid = $props.id();
  let {
    title,
    description,
    eyebrow,
    titleId = uid,
    class: className = '',
    actions,
    children,
    density = 'default',
  }: Props = $props();
</script>

<svelte:head>
  <title>{title} - Sable</title>
</svelte:head>

<main class={['app-page-shell', `app-page-shell-${density}`, className]}>
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
    padding: var(--page-gutter);
    width: 100%;
  }

  .app-page-header {
    align-items: stretch;
    flex-direction: column;
    margin-bottom: var(--page-gutter);
  }

  .app-page-header h1 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .app-page-header p {
    color: var(--sable-surface-var-on-container);
    margin: var(--space-200) 0 0;
    max-width: 65ch;
  }

  .app-page-header > div:first-child {
    min-width: 0;
  }

  .app-page-eyebrow {
    color: var(--sable-primary-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.08em;
    margin: 0 0 var(--space-200);
    text-transform: uppercase;
  }

  .app-page-header,
  .app-page-actions {
    display: flex;
    gap: var(--space-400);
    justify-content: space-between;
  }

  .app-page-actions {
    align-items: center;
  }

  .app-page-shell-compact {
    padding: var(--space-400);
  }

  .app-page-shell-compact .app-page-header {
    align-items: center;
    flex-direction: row;
    margin-bottom: var(--space-400);
  }

  @media (width >= 42rem) {
    .app-page-header {
      align-items: center;
      flex-direction: row;
    }

    .app-page-shell-compact {
      padding: var(--space-500);
    }
  }
</style>
