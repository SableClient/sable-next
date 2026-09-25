<script lang="ts">
  import { ContextMenu } from 'bits-ui';
  import IconContext from 'phosphor-svelte/lib/IconContext';

  import { i18n } from '#lib/i18n.js';
  import '#lib/ui/primitives/menu.css';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';

  import { messageMenuRows } from './message-menu-items';
  import type { OpenMessageMenu } from './message-menu-open.svelte.js';
  import MessageQuickReactions from './MessageQuickReactions.svelte';

  let { menu }: { menu: OpenMessageMenu } = $props();

  let open = $derived(menu.id !== null && menu.actions !== null);
  let anchor = $derived.by(() => {
    const { x, y } = menu.point;
    return { getBoundingClientRect: () => DOMRect.fromRect({ x, y, width: 0, height: 0 }) };
  });
</script>

<ContextMenu.Root
  bind:open={
    () => open,
    (next: boolean) => {
      if (!next) menu.close();
    }
  }
>
  {#if open && menu.actions}
    {@const actions = menu.actions()}
    <ContextMenu.Portal>
      <ContextMenu.Content
        class="menu-surface message-menu"
        {...overlayLayer()}
        loop
        collisionPadding={8}
        customAnchor={anchor}
      >
        <IconContext values={{ 'aria-hidden': 'true' }}>
          {#if actions.onReact}
            {@const react = actions.onReact}
            <MessageQuickReactions
              count={4}
              loadImagePacks={actions.loadImagePacks}
              onReact={react}
              roomId={actions.roomId}
            />
          {/if}
          {#each messageMenuRows(actions) as row (row.key)}
            {@const RowIcon = row.icon}
            {#if row.separated}
              <ContextMenu.Separator class="menu-separator" />
            {/if}
            <ContextMenu.Item
              class={[
                'menu-item menu-item-trailing-icon',
                row.destructive && 'menu-item-destructive',
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
