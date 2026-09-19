<script lang="ts">
  import { Popover } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import type { PackImageView } from '#src/generated/protocol';

  import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import EmoteBoard from '#lib/ui/primitives/EmoteBoard.svelte';

  interface Props {
    label: string;
    open?: boolean;
    roomId?: string;
    triggerClass?: string;
    anchor?: HTMLElement | CursorAnchor | null;
    onPick: (key: string, sourcePack?: PackImageView['source_pack']) => void;
    onOpenChange?: (open: boolean) => void;
    children?: Snippet;
  }

  let {
    label,
    open = $bindable(false),
    roomId = '',
    triggerClass = '',
    anchor = null,
    onPick,
    onOpenChange,
    children,
  }: Props = $props();
  let revision = $state(0);
  let trigger = $state<HTMLElement | null>(null);
  let frozen = $state.raw<CursorAnchor | null>(null);

  function handleOpenChange(next: boolean): void {
    open = next;
    if (next) {
      revision += 1;
      const rect = (anchor ?? trigger)?.getBoundingClientRect() ?? null;
      frozen = rect ? { getBoundingClientRect: () => rect } : null;
    } else {
      frozen = null;
    }
    onOpenChange?.(next);
  }

  function pick(key: string, sourcePack: PackImageView['source_pack'] = null): void {
    open = false;
    onOpenChange?.(false);
    onPick(key, sourcePack);
  }

  function pickImage(image: PackImageView): void {
    pick(image.url, image.source_pack);
  }
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
  {#if children}
    <Popover.Trigger bind:ref={trigger} class={['selection-open', triggerClass]} aria-label={label}>
      {@render children()}
    </Popover.Trigger>
  {/if}
  <Popover.Portal>
    <Popover.Content
      class="reaction-picker"
      {...overlayLayer()}
      side="top"
      align="end"
      collisionPadding={12}
      customAnchor={frozen ?? anchor}
      aria-label={label}
    >
      {#key revision}
        <EmoteBoard {roomId} unicode stickers={false} onPick={pickImage} onPickUnicode={pick} />
      {/key}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  :global(.reaction-picker) {
    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    color: var(--surface-on-container);
    overflow: hidden;
  }
</style>
