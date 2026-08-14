<script lang="ts">
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';

  interface Props {
    open?: boolean;
    label: string;
    closeLabel: string;
    onOpenChange?: (open: boolean) => void;
    children: Snippet;
  }

  let { open = $bindable(false), label, closeLabel, onOpenChange, children }: Props = $props();
  let pointerId = $state<number | null>(null);
  let startY = 0;
  let dragProgress = $state(0);
  let suppressClick = false;

  function handleOpenChange(next: boolean): void {
    open = next;
    onOpenChange?.(next);
  }

  function close(): void {
    open = false;
    onOpenChange?.(false);
  }

  function startDrag(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    pointerId = event.pointerId;
    startY = event.clientY;
    dragProgress = 0;
    suppressClick = false;
    const target = event.currentTarget;
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId);
  }

  function drag(event: PointerEvent): void {
    if (pointerId !== event.pointerId) return;
    const viewportHeight = Math.max(window.innerHeight, 1);
    dragProgress = Math.min(Math.max(0, event.clientY - startY) / viewportHeight, 0.5);
    if (dragProgress > 0) suppressClick = true;
  }

  function endDrag(event: PointerEvent): void {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    if (dragProgress >= 0.18) {
      close();
      return;
    }
    dragProgress = 0;
  }

  function handleClick(event: MouseEvent): void {
    if (suppressClick) {
      event.preventDefault();
      suppressClick = false;
      return;
    }
    close();
  }
</script>

<Dialog.Root bind:open onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="sable-bottom-sheet-backdrop" />
    <Dialog.Content
      class="sable-bottom-sheet"
      style={`transform: translateY(${String(dragProgress * 100)}%)`}
      aria-label={label}
    >
      <button
        class="handle"
        type="button"
        aria-label={closeLabel}
        onclick={handleClick}
        onpointerdown={startDrag}
        onpointermove={drag}
        onpointerup={endDrag}
        onpointercancel={endDrag}
      ></button>
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.sable-bottom-sheet-backdrop) {
    background: var(--sable-overlay);
    inset: 0;
    position: fixed;
    z-index: calc(var(--layer-popover) + 2);
  }

  :global(.sable-bottom-sheet) {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius) var(--radius) 0 0;
    bottom: 0;
    box-shadow: var(--shadow-dialog);
    box-sizing: border-box;
    max-height: calc(100dvh - var(--space-2) * 2);
    overflow: auto;
    overscroll-behavior: contain;
    padding: 0;
    position: fixed;
    width: 100%;
    z-index: calc(var(--layer-popover) + 3);
  }

  .handle {
    background: var(--sable-surface-var-container);
    border: 0;
    border-radius: var(--radius-pill);
    display: block;
    height: 0.25rem;
    left: 50%;
    position: absolute;
    top: var(--space-2);
    touch-action: none;
    transform: translateX(-50%);
    width: 2.5rem;
    z-index: 1;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.sable-bottom-sheet-backdrop) {
      animation: bottom-sheet-backdrop-in var(--motion-normal) var(--motion-easing-standard);
    }

    :global(.sable-bottom-sheet) {
      animation: bottom-sheet-in var(--motion-slow) var(--motion-easing-emphasized);
    }
  }

  @keyframes bottom-sheet-backdrop-in {
    from {
      opacity: 0;
    }
  }

  @keyframes bottom-sheet-in {
    from {
      opacity: 0;
      transform: translateY(var(--space-2));
    }
  }
</style>
