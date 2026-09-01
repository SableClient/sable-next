<script lang="ts">
  import { ContextMenu } from 'bits-ui';
  import IconContext from 'phosphor-svelte/lib/IconContext';

  import { i18n } from '#lib/i18n.js';
  import '#lib/ui/primitives/menu.css';

  import { messageMenuRows } from './message-menu-items';
  import { openMessageMenu } from './message-menu-open.svelte.js';
  import MessageQuickReactions from './MessageQuickReactions.svelte';

  let open = $derived(openMessageMenu.id !== null && openMessageMenu.actions !== null);
  let anchor = $derived.by(() => {
    const { x, y } = openMessageMenu.point;
    return { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) };
  });
</script>

<ContextMenu.Root
  bind:open={
    () => open,
    (next: boolean) => {
      if (!next) openMessageMenu.close();
    }
  }
>
  {#if open && openMessageMenu.actions}
    {@const actions = openMessageMenu.actions()}
    <ContextMenu.Portal>
      <ContextMenu.Content
        class="sable-menu message-menu"
        loop
        collisionPadding={8}
        customAnchor={anchor}
      >
        <IconContext values={{ 'aria-hidden': 'true' }}>
          {#if actions.onReact}
            {@const react = actions.onReact}
            <MessageQuickReactions count={4} onReact={react} />
          {/if}
          {#each messageMenuRows(actions) as row (row.key)}
            {@const RowIcon = row.icon}
            {#if row.separated}
              <ContextMenu.Separator class="sable-menu-separator" />
            {/if}
            <ContextMenu.Item
              class={[
                'sable-menu-item sable-menu-item-trailing-icon',
                row.destructive && 'sable-menu-item-destructive',
              ]}
              onclick={row.run}
            >
              <RowIcon />
              <span>{$i18n.t(row.label)}</span>
            </ContextMenu.Item>
          {/each}
        </IconContext>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  {/if}
</ContextMenu.Root>
