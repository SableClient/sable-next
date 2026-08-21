<script lang="ts">
  import type { Snippet } from 'svelte';

  import DialogFrame from './DialogFrame.svelte';

  interface Props {
    open?: boolean;
    label: string;
    closeLabel: string;
    handleColor?: string;
    handleOpacity?: number;
    background?: string;
    contentInset?: boolean;
    fullHeight?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: Snippet;
  }

  let {
    open = $bindable(false),
    label,
    closeLabel,
    handleColor = 'var(--sable-surface-on-container)',
    handleOpacity = 0.45,
    background,
    contentInset = true,
    fullHeight = false,
    onOpenChange,
    children,
  }: Props = $props();
  let pointerId = $state<number | null>(null);
  let startY = 0;
  let dragProgress = $state(0);
  let suppressClick = false;

  $effect(() => {
    // Closing from the outside unmounts the handle mid-drag, so `endDrag` never
    // runs and the next open would render pushed down.
    if (!open) {
      pointerId = null;
      dragProgress = 0;
    }
  });

  function close(): void {
    // Left set, this transform reopens the sheet already pushed off screen.
    dragProgress = 0;
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

<DialogFrame
  bind:open
  variant="sheet"
  {label}
  contentStyle={`${background ? `background: ${background};` : ''} ${fullHeight ? 'height: calc(100dvh - var(--safe-top) - var(--safe-bottom) - var(--space-2) * 2);' : ''} transform: translateY(${String(dragProgress * 100)}%)`}
  {onOpenChange}
>
  <div class:content-inset={contentInset}>{@render children()}</div>
  <button
    class="bottom-sheet-handle"
    type="button"
    aria-label={closeLabel}
    onclick={handleClick}
    onpointerdown={startDrag}
    onpointermove={drag}
    onpointerup={endDrag}
    onpointercancel={endDrag}
  >
    <span
      class="bottom-sheet-pill"
      aria-hidden="true"
      style:background={handleColor}
      style:opacity={handleOpacity}
    ></span>
  </button>
</DialogFrame>

<style>
  /* Above sticky headers (z-index 1) in sheet content. */
  :global(.bottom-sheet-handle) {
    background: transparent;
    border: 0;
    border-radius: var(--radius-pill);
    cursor: grab;
    display: grid;
    height: var(--control-height-medium);
    left: 50%;
    padding: 0;
    place-items: center;
    position: absolute;
    top: 0;
    touch-action: none;
    transform: translateX(-50%);
    width: 4rem;
    z-index: 3;
  }

  :global(.bottom-sheet-handle):active {
    cursor: grabbing;
  }

  :global(.bottom-sheet-pill) {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    display: block;
    height: 0.25rem;
    opacity: 0.45;
    width: 2.5rem;
  }

  :global(.bottom-sheet-handle):focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .content-inset {
    padding: var(--control-height-medium) 0 var(--space-4);
  }
</style>
