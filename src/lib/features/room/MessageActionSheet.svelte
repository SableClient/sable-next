<script lang="ts">
  import IconContext from 'phosphor-svelte/lib/IconContext';

  import { i18n } from '#lib/i18n.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import '#lib/ui/primitives/menu.css';

  import MessageQuickReactions from './MessageQuickReactions.svelte';
  import { messageMenuRows, type MessageActions } from './message-menu-items';

  type Props = MessageActions & {
    open?: boolean;
    preview?: string | null;
  };

  let { open = $bindable(false), preview = null, ...actions }: Props = $props();

  function run(action: () => void): void {
    open = false;
    action();
  }

  function react(emoji: string): void {
    open = false;
    actions.onReact?.(emoji);
  }
</script>

<BottomSheet
  bind:open
  label={$i18n.t('timeline.moreActions')}
  closeLabel={$i18n.t('timeline.closeMenu')}
>
  {#if preview}
    <p class="sheet-source">{preview}</p>
    <div class="sheet-line"></div>
  {/if}
  <IconContext values={{ 'aria-hidden': 'true' }}>
    {#if actions.onReact}
      <MessageQuickReactions count={8} onReact={react} roomy />
    {/if}
    <div class="sheet-list">
      {#each messageMenuRows(actions) as row (row.key)}
        {@const RowIcon = row.icon}
        {#if row.separated}<div class="sheet-line"></div>{/if}
        <button
          type="button"
          class={[
            'sable-menu-item sable-menu-item-trailing-icon',
            row.destructive && 'sable-menu-item-destructive',
          ]}
          onclick={() => {
            run(row.run);
          }}
        >
          <RowIcon />
          <span>{$i18n.t(row.label)}</span>
        </button>
      {/each}
    </div>
  </IconContext>
</BottomSheet>

<style>
  .sheet-source {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0 0 var(--space-200);
    overflow: hidden;
    padding: 0 var(--space-400);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sheet-line {
    background: var(--sable-surface-container-line);
    block-size: var(--border-width);
  }

  .sheet-list {
    display: grid;
  }

  .sheet-list :global(.sable-menu-item) {
    --menu-item-height: var(--control-height-400);
    --menu-item-padding: var(--space-400);
    --menu-item-radius: var(--radii-300);

    font-size: var(--font-size-body);
  }
</style>
