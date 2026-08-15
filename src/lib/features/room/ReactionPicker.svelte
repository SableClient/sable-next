<script lang="ts">
  import { Popover } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import type { PackImageView } from '@/generated/PackImageView';

  import EmoteBoard from '$lib/ui/primitives/EmoteBoard.svelte';

  interface Props {
    label: string;
    roomId?: string;
    triggerClass?: string;
    onPick: (key: string) => void;
    onOpenChange?: (open: boolean) => void;
    children: Snippet;
  }

  let { label, roomId = '', triggerClass = '', onPick, onOpenChange, children }: Props = $props();
  let open = $state(false);
  let revision = $state(0);

  function handleOpenChange(next: boolean): void {
    open = next;
    if (next) revision += 1;
    onOpenChange?.(next);
  }

  function pick(key: string): void {
    open = false;
    onOpenChange?.(false);
    onPick(key);
  }

  function pickImage(image: PackImageView): void {
    // Custom-emote reactions travel as the mxc URI, which is what the room already sends.
    pick(image.url);
  }
</script>

<Popover.Root bind:open onOpenChange={handleOpenChange}>
  <Popover.Trigger class={triggerClass} aria-label={label}>
    {@render children()}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content class="reaction-picker" side="top" align="end" collisionPadding={12}>
      {#key revision}
        <EmoteBoard {roomId} unicode stickers={false} onPick={pickImage} onPickUnicode={pick} />
      {/key}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  :global(.reaction-picker) {
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-float);
    color: var(--sable-surface-on-container);
    overflow: hidden;
    z-index: var(--layer-popover);
  }
</style>
