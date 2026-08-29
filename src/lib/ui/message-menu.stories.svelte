<script module lang="ts">
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import IconContext from 'phosphor-svelte/lib/IconContext';

  import MessageQuickReactions from '#lib/features/room/MessageQuickReactions.svelte';
  import { messageMenuRows } from '#lib/features/room/message-menu-items.js';
  import '#lib/ui/primitives/menu.css';

  const { Story } = defineMeta({
    title: 'Room/Message menu',
    tags: ['autodocs'],
  });

  const decorative = { 'aria-hidden': 'true' } as const;
  const noop = (): void => {};

  const rows = messageMenuRows({
    onReact: noop,
    onReply: noop,
    onEdit: noop,
    onCopyText: noop,
    onCopyLink: noop,
    onViewReactions: noop,
    onReadReceipts: noop,
    onDelete: noop,
  });
</script>

<Story name="Desktop context menu" asChild>
  <div class="sable-menu demo">
    <IconContext values={decorative}>
      <MessageQuickReactions count={4} onReact={noop} />
      {#each rows as row (row.key)}
        {@const RowIcon = row.icon}
        {#if row.separated}<div class="line"></div>{/if}
        <button
          type="button"
          class={[
            'sable-menu-item sable-menu-item-trailing-icon',
            row.destructive && 'sable-menu-item-destructive',
          ]}
        >
          <RowIcon />
          <span>{row.label.replace('timeline.', '')}</span>
        </button>
      {/each}
    </IconContext>
  </div>
</Story>

<Story name="Touch sheet" asChild>
  <div class="sheet">
    <IconContext values={decorative}>
      <p class="preview">Shipped the search crawl fix, coverage looks right now</p>
      <div class="line"></div>
      <MessageQuickReactions count={8} onReact={noop} />
      <div class="sheet-list">
        {#each rows as row (row.key)}
          {@const RowIcon = row.icon}
          {#if row.separated}<div class="line"></div>{/if}
          <button
            type="button"
            class={[
              'sable-menu-item sable-menu-item-trailing-icon',
              row.destructive && 'sable-menu-item-destructive',
            ]}
          >
            <RowIcon />
            <span>{row.label.replace('timeline.', '')}</span>
          </button>
        {/each}
      </div>
    </IconContext>
  </div>
</Story>

<style>
  .demo {
    --menu-min-width: 15rem;

    width: max-content;
  }

  .sheet {
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radii-400) var(--radii-400) 0 0;
    max-width: 26rem;
    padding-block: var(--space-400);
  }

  .sheet-list {
    display: grid;
  }

  .sheet-list :global(.sable-menu-item) {
    --menu-item-padding: var(--space-400);
    --menu-item-radius: var(--radii-300);
  }

  .preview {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0 0 var(--space-200);
    overflow: hidden;
    padding: 0 var(--space-400);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .line {
    background: var(--sable-surface-container-line);
    block-size: var(--border-width);
  }
</style>
