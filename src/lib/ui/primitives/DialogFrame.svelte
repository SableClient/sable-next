<script lang="ts">
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';

  type DialogVariant = 'drawer' | 'verification';

  interface Props {
    open?: boolean;
    variant: DialogVariant;
    onOpenChange?: (open: boolean) => void;
    children: Snippet;
  }

  let { open = $bindable(), variant, onOpenChange, children }: Props = $props();

  function handleOpenChange(next: boolean): void {
    open = next;
    onOpenChange?.(next);
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class={['sable-dialog-backdrop', `sable-dialog-backdrop-${variant}`]} />
    <Dialog.Content class={['sable-dialog-content', `sable-dialog-content-${variant}`]}>
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.sable-dialog-backdrop) {
    background: var(--sable-overlay);
    inset: 0;
    position: fixed;
  }

  :global(.sable-dialog-content) {
    box-sizing: border-box;
    position: fixed;
  }

  :global(.sable-dialog-backdrop-drawer) {
    border: 0;
    z-index: 10;
  }

  :global(.sable-dialog-content-drawer) {
    border: 0;
    inset: 0 0 0 auto;
    max-width: min(22rem, 85%);
    padding: 0;
    width: 100%;
    z-index: 11;
  }

  :global(.sable-dialog-backdrop-verification) {
    z-index: 40;
  }

  :global(.sable-dialog-content-verification) {
    background: var(--sable-primary-container);
    border: 1px solid var(--sable-primary-container-line);
    border-radius: var(--radius) var(--radius) 0 0;
    bottom: 0;
    box-shadow: var(--shadow-dialog);
    max-height: calc(100dvh - 1.5rem);
    overflow: auto;
    padding: 1.25rem;
    width: 100%;
    z-index: 41;
  }

  @media (width >= 42rem) {
    :global(.sable-dialog-content-verification) {
      border-radius: var(--radius);
      bottom: auto;
      left: 50%;
      max-width: 34rem;
      padding: 1.5rem;
      top: 50%;
      transform: translate(-50%, -50%);
    }
  }
</style>
