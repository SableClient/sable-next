<script lang="ts">
  import { i18n } from '$lib/i18n';
  import Skeleton from '$lib/ui/primitives/Skeleton.svelte';

  const REVEAL_DELAY = 150;
  const rows = [
    { id: 'sender-one', collapsed: false },
    { id: 'reply-one', collapsed: true },
    { id: 'reply-two', collapsed: true },
    { id: 'sender-two', collapsed: false },
  ] as const;

  let visible = $state(false);

  $effect(() => {
    const timer = setTimeout(() => {
      visible = true;
    }, REVEAL_DELAY);
    return () => {
      clearTimeout(timer);
    };
  });
</script>

{#if visible}
  <div class="timeline-skeleton" aria-label={$i18n.t('timeline.loading')} role="status">
    {#each rows as row (row.id)}
      <div class={['timeline-skeleton-row', { collapsed: row.collapsed }]} aria-hidden="true">
        {#if !row.collapsed}<Skeleton class="timeline-skeleton-avatar" />{/if}
        <div class="timeline-skeleton-copy">
          {#if !row.collapsed}
            <div class="timeline-skeleton-header">
              <Skeleton class="timeline-skeleton-sender" />
              <Skeleton class="timeline-skeleton-time" />
            </div>
          {/if}
          <Skeleton class="timeline-skeleton-body" />
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .timeline-skeleton {
    display: flex;
    flex-direction: column;
    inset: 0;
    justify-content: flex-end;
    overflow: hidden;
    padding: 0 var(--page-gutter) 1rem;
    pointer-events: none;
    position: absolute;
    z-index: 1;
  }

  .timeline-skeleton-row {
    display: flex;
    gap: var(--timeline-row-gap);
    padding: var(--timeline-row-padding) 0;
  }

  .timeline-skeleton-row.collapsed {
    padding-left: calc(var(--avatar-size-small) + var(--timeline-row-gap));
  }

  .timeline-skeleton-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.375rem;
    justify-content: center;
    min-width: 0;
  }

  .timeline-skeleton-header {
    align-items: center;
    display: flex;
    gap: 0.5rem;
    height: 1rem;
  }

  :global(.sable-skeleton.timeline-skeleton-avatar) {
    border-radius: var(--radius-pill);
    flex: 0 0 var(--avatar-size-small);
    height: var(--avatar-size-small);
    width: var(--avatar-size-small);
  }

  :global(.sable-skeleton.timeline-skeleton-sender) {
    height: 0.625rem;
    width: 6.5rem;
  }

  :global(.sable-skeleton.timeline-skeleton-time) {
    height: 0.5rem;
    width: 3rem;
  }

  :global(.sable-skeleton.timeline-skeleton-body) {
    height: 0.75rem;
    max-width: 28rem;
    width: 58%;
  }

  .timeline-skeleton :global(.sable-skeleton) {
    animation: none;
    opacity: 0.65;
  }

  .timeline-skeleton-row:nth-child(2) :global(.timeline-skeleton-body) {
    width: 42%;
  }

  .timeline-skeleton-row:nth-child(3) :global(.timeline-skeleton-body) {
    width: 68%;
  }

  .timeline-skeleton-row:nth-child(4) :global(.timeline-skeleton-body) {
    width: 48%;
  }
</style>
