<script lang="ts">
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';

  interface Props {
    rows: number;
    divided?: boolean;
  }

  let { rows, divided = false }: Props = $props();
</script>

<ul class="rows" class:divided aria-hidden="true">
  {#each Array.from({ length: rows }, (_, index) => index) as row (row)}
    <li class="row">
      <Skeleton class="row-avatar" />
      <div class="row-text">
        <Skeleton class="row-name" />
        <Skeleton class="row-meta" />
      </div>
    </li>
  {/each}
</ul>

<style>
  .rows {
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row {
    align-items: center;
    display: flex;
    gap: var(--space-400);
    padding: var(--space-300) var(--space-400);
  }

  .row + .row,
  .divided > .row:first-child {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
  }

  .row-text {
    display: grid;
    flex: 1;
    gap: var(--space-050);
    min-width: 0;
  }

  .row :global(.row-avatar) {
    block-size: var(--avatar-size-small);
    border-radius: var(--radius-pill);
    flex: none;
    inline-size: var(--avatar-size-small);
  }

  .row-text :global(.row-name),
  .row-text :global(.row-meta) {
    block-size: 0.75rem;
  }

  .row-text :global(.row-name) {
    inline-size: 30%;
  }

  .row-text :global(.row-meta) {
    inline-size: 55%;
  }
</style>
