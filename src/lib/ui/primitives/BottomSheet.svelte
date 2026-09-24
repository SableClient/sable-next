<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import { on } from 'svelte/events';

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
    ownsBack?: boolean;
    onOpenChange?: (open: boolean) => void;
    onOpenAutoFocus?: (event: Event) => void;
    children: Snippet;
  }

  let {
    open = $bindable(false),
    label,
    closeLabel,
    handleColor = 'var(--surface-on-container)',
    handleOpacity = 0.45,
    background,
    contentInset = true,
    fullHeight = false,
    ownsBack = false,
    onOpenChange,
    onOpenAutoFocus,
    children,
  }: Props = $props();
  let pointerId = $state<number | null>(null);
  let startY = 0;
  let lastY = 0;
  let lastTime = 0;
  let velocityY = 0;
  let dragProgress = $state(0);
  let suppressClick = false;
  let touchDragging = $state(false);
  const dismissVelocity = 0.3;
  const NO_DRAG =
    '[data-sheet-no-drag], input, textarea, select, [contenteditable="true"], .slider';

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
    lastY = event.clientY;
    lastTime = event.timeStamp;
    velocityY = 0;
    dragProgress = 0;
    suppressClick = false;
  }

  function trackVelocity(event: PointerEvent): void {
    const elapsed = event.timeStamp - lastTime;
    if (elapsed <= 0) return;
    velocityY = (event.clientY - lastY) / elapsed;
    lastY = event.clientY;
    lastTime = event.timeStamp;
  }

  function drag(event: PointerEvent): void {
    if (pointerId !== event.pointerId) return;
    trackVelocity(event);
    const viewportHeight = Math.max(window.innerHeight, 1);
    dragProgress = Math.min(Math.max(0, event.clientY - startY) / viewportHeight, 0.5);
    if (dragProgress <= 0) return;
    suppressClick = true;
    const target = event.currentTarget;
    if (target instanceof HTMLElement && !target.hasPointerCapture(event.pointerId)) {
      target.setPointerCapture(event.pointerId);
    }
  }

  function startContentDrag(event: PointerEvent): void {
    if (event.pointerType === 'touch') return;
    startDrag(event);
  }

  function scrolledAway(from: Element | null, boundary: Element): boolean {
    for (let element = from; element; element = element.parentElement) {
      const { overflowY } = getComputedStyle(element);
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        element.scrollHeight > element.clientHeight &&
        element.scrollTop > 0
      ) {
        return true;
      }
      if (element === boundary) return false;
    }
    return false;
  }

  function settle(moved: number, velocity: number): void {
    const viewportHeight = Math.max(window.innerHeight, 1);
    if (moved / viewportHeight >= 0.18 || velocity >= dismissVelocity) close();
    else dragProgress = 0;
  }

  const swipeToDismiss: Attachment<HTMLElement> = (node) => {
    let claimable = false;
    let originX = 0;
    let originY = 0;
    let moved = 0;
    let previousY = 0;
    let previousTime = 0;
    let velocity = 0;

    function start(event: TouchEvent): void {
      const touch = event.touches.item(0);
      const sheet = node.closest('.dialog-content');
      touchDragging = false;
      suppressClick = false;
      claimable =
        event.touches.length === 1 &&
        touch !== null &&
        sheet !== null &&
        !(event.target instanceof Element && event.target.closest(NO_DRAG)) &&
        !window.getSelection()?.toString() &&
        !scrolledAway(event.target instanceof Element ? event.target : null, sheet);
      if (!touch) return;
      originX = touch.clientX;
      originY = touch.clientY;
      previousY = touch.clientY;
      previousTime = event.timeStamp;
      moved = 0;
      velocity = 0;
    }

    function move(event: TouchEvent): void {
      const touch = event.touches.item(0);
      if (!claimable || !touch) return;
      const deltaY = touch.clientY - originY;
      if (!touchDragging) {
        if (deltaY <= 0 || Math.abs(touch.clientX - originX) > deltaY) {
          claimable = false;
          return;
        }
        touchDragging = true;
        suppressClick = true;
      }
      event.preventDefault();
      const elapsed = event.timeStamp - previousTime;
      if (elapsed > 0) velocity = (touch.clientY - previousY) / elapsed;
      previousY = touch.clientY;
      previousTime = event.timeStamp;
      moved = Math.max(0, deltaY);
      dragProgress = Math.min(moved / Math.max(window.innerHeight, 1), 0.5);
    }

    function end(): void {
      claimable = false;
      if (!touchDragging) return;
      touchDragging = false;
      settle(moved, velocity);
    }

    const offs = [
      on(node, 'touchstart', start, { passive: true }),
      on(node, 'touchmove', move, { passive: false }),
      on(node, 'touchend', end),
      on(node, 'touchcancel', end),
    ];
    return () => {
      for (const off of offs) off();
    };
  };

  function contentClick(event: MouseEvent): void {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick = false;
  }

  function endDrag(event: PointerEvent): void {
    if (pointerId !== event.pointerId) return;
    trackVelocity(event);
    pointerId = null;
    settle(dragProgress * Math.max(window.innerHeight, 1), velocityY);
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
  {ownsBack}
  {label}
  contentClass={pointerId !== null || touchDragging ? 'sheet-dragging' : 'sheet-settling'}
  contentStyle={`${background ? `background: ${background};` : ''} ${fullHeight ? 'height: calc(100dvh - var(--safe-top) - var(--safe-bottom) - var(--space-300) * 2);' : ''} transform: translateY(${String(dragProgress * 100)}%)`}
  {onOpenChange}
  {onOpenAutoFocus}
>
  <div
    class:content-inset={contentInset}
    role="presentation"
    onclickcapture={contentClick}
    onpointerdown={startContentDrag}
    onpointermove={drag}
    onpointerup={endDrag}
    onpointercancel={endDrag}
    {@attach swipeToDismiss}
  >
    {@render children()}
  </div>
  <div
    class="bottom-sheet-grip"
    role="presentation"
    onpointerdown={startDrag}
    onpointermove={drag}
    onpointerup={endDrag}
    onpointercancel={endDrag}
  >
    <button class="bottom-sheet-handle" type="button" aria-label={closeLabel} onclick={handleClick}>
      <span
        class="bottom-sheet-pill"
        aria-hidden="true"
        style:background={handleColor}
        style:opacity={handleOpacity}
      ></span>
    </button>
  </div>
</DialogFrame>

<style>
  /* Above sticky headers (z-index 1) in sheet content. */
  :global(.bottom-sheet-grip) {
    display: grid;
    height: var(--control-height-medium);
    left: 50%;
    place-items: center;
    position: absolute;
    top: 0;
    touch-action: none;
    transform: translateX(-50%);
    width: 100%;
    z-index: 3;
  }

  :global(.bottom-sheet-handle) {
    background: transparent;
    border: 0;
    border-radius: var(--radius-pill);
    cursor: grab;
    display: grid;
    height: 100%;
    padding: 0;
    place-items: center;
    width: 4rem;
  }

  :global(.bottom-sheet-handle):active {
    cursor: grabbing;
  }

  :global(.bottom-sheet-pill) {
    background: var(--surface-var-container);
    border-radius: var(--radius-pill);
    display: block;
    height: 0.25rem;
    opacity: 0.45;
    width: 2.5rem;
  }

  :global(.bottom-sheet-handle):focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .content-inset {
    padding: var(--control-height-medium) 0 var(--space-400);
  }
</style>
