<script lang="ts">
  import type { Snippet } from 'svelte';

  import DialogFrame from './DialogFrame.svelte';

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

<DialogFrame
  bind:open
  variant="sheet"
  {label}
  contentStyle={`transform: translateY(${String(dragProgress * 100)}%)`}
  {onOpenChange}
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
</DialogFrame>

<style>
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
</style>
