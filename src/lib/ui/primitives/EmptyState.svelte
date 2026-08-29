<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  type Props = {
    eyebrow?: string;
    title: string;
    description?: string;
    titleId?: string;
    class?: ClassValue;
    actions?: Snippet;
  };

  const uid = $props.id();
  let {
    eyebrow,
    title,
    description,
    titleId = uid,
    class: className = '',
    actions,
  }: Props = $props();
</script>

<section class={['empty-state', className]} aria-labelledby={titleId}>
  <div class="empty-state-content">
    {#if eyebrow}<p class="empty-state-eyebrow">{eyebrow}</p>{/if}
    <h1 id={titleId}>{title}</h1>
    {#if description}<p class="empty-state-description">{description}</p>{/if}
    {#if actions}<div class="empty-state-actions">{@render actions()}</div>{/if}
  </div>
</section>

<style>
  .empty-state {
    align-items: center;
    display: flex;
    min-height: 100%;
    padding: var(--space-700) var(--page-gutter);
  }

  .empty-state-content {
    margin: 0 auto;
    max-width: 28rem;
    text-align: center;
    width: 100%;
  }

  .empty-state-eyebrow {
    color: var(--sable-primary-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.08em;
    margin: 0 0 var(--space-1);
    text-transform: uppercase;
  }

  .empty-state h1 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .empty-state-description {
    color: var(--sable-surface-var-on-container);
    margin: var(--space-3) 0 0;
  }

  .empty-state-actions {
    display: grid;
    gap: var(--space-2);
    margin-top: var(--space-4);
  }

  @media (width >= 32rem) {
    .empty-state-actions {
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    }
  }
</style>
