<script lang="ts">
  import { Popover } from 'bits-ui';
  import type { Snippet } from 'svelte';

  import { AppLayout } from '#lib/ui/app-layout.svelte.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import { collisionPadding as insetCollisionPadding } from '#lib/ui/titlebar-inset.svelte.js';

  import BottomSheet from './BottomSheet.svelte';

  interface Props {
    open?: boolean;
    anchor?: HTMLElement | null;
    class?: string;
    side?: 'top' | 'bottom' | 'left' | 'right';
    align?: 'start' | 'center' | 'end';
    sideOffset?: number;
    collisionPadding?: number;
    sticky?: 'partial' | 'always';
    closeOnAnchorHidden?: boolean;
    label: string;
    closeLabel: string;
    handleColor?: string;
    handleOpacity?: number;
    contentInset?: boolean;
    onOpenChange?: (open: boolean) => void;
    onCloseAutoFocus?: (event: Event) => void;
    trigger?: Snippet<[{ props: Record<string, unknown> }]>;
    children: Snippet<[boolean]>;
  }

  let {
    open = $bindable(false),
    anchor = null,
    class: popoverClass,
    side = 'top',
    align = 'start',
    sideOffset,
    collisionPadding,
    sticky,
    closeOnAnchorHidden = false,
    label,
    closeLabel,
    handleColor,
    handleOpacity,
    contentInset,
    onOpenChange,
    onCloseAutoFocus,
    trigger,
    children,
  }: Props = $props();

  const appLayout = new AppLayout();
  let desktop = $derived(appLayout.current);

  $effect(() => {
    if (!closeOnAnchorHidden || !open || !desktop || !anchor) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => !entry.isIntersecting)) {
        open = false;
        onOpenChange?.(false);
      }
    });
    observer.observe(anchor);
    return () => {
      observer.disconnect();
    };
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

{#if desktop && (trigger || anchor)}
  <Popover.Root bind:open {onOpenChange}>
    {#if trigger}
      <Popover.Trigger>
        {#snippet child({ props })}{@render trigger({ props })}{/snippet}
      </Popover.Trigger>
    {/if}
    <Popover.Portal>
      <Popover.Content
        class={['responsive-popover', popoverClass]}
        {...overlayLayer()}
        customAnchor={trigger ? null : anchor}
        {side}
        {align}
        {sideOffset}
        collisionPadding={insetCollisionPadding(collisionPadding)}
        {sticky}
        {onCloseAutoFocus}
      >
        {@render children(false)}
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  {#if trigger}{@render trigger({ props: sheetTrigger })}{/if}
  <BottomSheet
    bind:open
    {label}
    {closeLabel}
    {handleColor}
    {handleOpacity}
    {contentInset}
    {onOpenChange}
  >
    {@render children(true)}
  </BottomSheet>
{/if}

<style>
  :global(.responsive-popover) {
    box-shadow: var(--shadow-dialog);
    padding: 0;
    width: min(22rem, calc(100vw - 2rem));
  }
</style>
