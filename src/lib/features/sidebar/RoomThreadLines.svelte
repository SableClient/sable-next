<script lang="ts">
  import type { Thread } from './space-tree.js';

  interface Props {
    threads: readonly Thread[] | undefined;
    collapsed: boolean;
  }

  let { threads, collapsed }: Props = $props();
</script>

{#if !collapsed && threads}
  {#each threads as thread (thread.level)}
    <span class="thread" style:--thread-level={thread.level} aria-hidden="true">
      {#if thread.kind !== 'last'}<span class="thread-line"></span>{/if}
      {#if thread.kind !== 'through'}<span class="thread-elbow"></span>{/if}
    </span>
  {/each}
{/if}

<style>
  .thread {
    display: contents;
  }

  .thread-line,
  .thread-elbow {
    border-color: var(--surface-container-line);
    border-style: solid;
    border-width: 0 0 0 var(--border-width-500);
    inset-inline-start: calc(
      var(--space-200) + var(--thread-level) * var(--space-400) + var(--space-400) / 2 -
        var(--border-width-500) / 2
    );
    pointer-events: none;
    position: absolute;
    top: 0;
  }

  .thread-line {
    bottom: 0;
  }

  .thread-elbow {
    border-bottom-width: var(--border-width-500);
    border-end-start-radius: var(--radii-300);
    bottom: calc(50% - var(--border-width-500) / 2);
    width: calc(var(--space-400) / 2 - var(--space-050));
  }
</style>
