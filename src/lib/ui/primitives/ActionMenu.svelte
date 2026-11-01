<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import type { Snippet } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import { collisionPadding } from '#lib/ui/titlebar-inset.svelte.js';

  import BottomSheet from './BottomSheet.svelte';
  import { setActionMenuSurface } from './action-menu.js';
  import './menu.css';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  interface Props {
    open?: boolean;
    label: string;
    class?: string;
    anchor?: HTMLElement | CursorAnchor | null;
    side?: 'top' | 'bottom' | 'left' | 'right';
    align?: 'start' | 'center' | 'end';
    sideOffset?: number;
    preventScroll?: boolean;
    onOpenChange?: (open: boolean) => void;
    trigger?: Snippet<[{ props: Record<string, unknown> }]>;
    children: Snippet;
  }

  let {
    open = $bindable(false),
    label,
    class: surfaceClass,
    anchor = null,
    side = 'bottom',
    align = 'end',
    sideOffset = 4,
    preventScroll,
    onOpenChange,
    trigger,
    children,
  }: Props = $props();

  const appLayout = new AppLayout();
  let sheet = $derived(!appLayout.current);

  setActionMenuSurface({
    get sheet() {
      return sheet;
    },
    close: () => {
      open = false;
      onOpenChange?.(false);
    },
  });

  let sheetTrigger = $derived({
    type: 'button',
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'data-state': open ? 'open' : 'closed',
    onclick: () => {
      open = true;
      onOpenChange?.(true);
    },
  });
</script>

{#if sheet}
  {#if trigger}{@render trigger({ props: sheetTrigger })}{/if}
  {#if open}
    <BottomSheet bind:open {label} closeLabel={i18n.t('timeline.closeMenu')} {onOpenChange}>
      <div class="action-menu-rows" role="menu">{@render children()}</div>
    </BottomSheet>
  {/if}
{:else}
  <DropdownMenu.Root bind:open {onOpenChange}>
    {#if trigger}
      <DropdownMenu.Trigger>
        {#snippet child({ props })}{@render trigger({ props })}{/snippet}
      </DropdownMenu.Trigger>
    {/if}
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        class={['menu-surface', surfaceClass]}
        {...overlayLayer()}
        customAnchor={anchor}
        aria-label={label}
        {side}
        {align}
        {sideOffset}
        collisionPadding={collisionPadding()}
        {preventScroll}
      >
        <div class="menu-scroll-content" {@attach scrollHint}>
          {@render children()}
        </div>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}

<style>
  .action-menu-rows {
    display: grid;
  }
</style>
