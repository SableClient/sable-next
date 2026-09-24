<script lang="ts">
  interface Props {
    value: number;
    min: number;
    max: number;
    label: string;
    valueText?: string;
    grow: 'left' | 'right' | 'down';
    step: number;
    shiftStep?: number;
    homeEnd?: boolean;
    fromPixels?: (pixels: number) => number;
    onResize: (next: number) => void;
    onCommit?: () => void;
  }

  let {
    value,
    min,
    max,
    label,
    valueText,
    grow,
    step,
    shiftStep = step,
    homeEnd = false,
    fromPixels = (pixels) => pixels,
    onResize,
    onCommit,
  }: Props = $props();

  let dragging = $state(false);
  let vertical = $derived(grow === 'down');
  let drag: { pointerId: number; start: number; startValue: number } | null = null;

  function start(event: PointerEvent & { currentTarget: HTMLButtonElement }): void {
    if (event.button !== 0) return;
    drag = {
      pointerId: event.pointerId,
      start: vertical ? event.clientY : event.clientX,
      startValue: value,
    };
    dragging = true;
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    const delta =
      grow === 'left'
        ? drag.start - event.clientX
        : (vertical ? event.clientY : event.clientX) - drag.start;
    onResize(drag.startValue + fromPixels(delta));
  }

  function finish(event: PointerEvent): void {
    if (drag === null || event.pointerId !== drag.pointerId) return;
    drag = null;
    dragging = false;
    onCommit?.();
  }

  function keydown(event: KeyboardEvent): void {
    const amount = event.shiftKey ? shiftStep : step;
    const leftward = grow === 'left' ? amount : -amount;
    if (vertical && event.key === 'ArrowDown') onResize(value + amount);
    else if (vertical && event.key === 'ArrowUp') onResize(value - amount);
    else if (!vertical && event.key === 'ArrowLeft') onResize(value + leftward);
    else if (!vertical && event.key === 'ArrowRight') onResize(value - leftward);
    else if (homeEnd && event.key === 'Home') onResize(min);
    else if (homeEnd && event.key === 'End') onResize(max);
    else return;
    event.preventDefault();
    onCommit?.();
  }
</script>

<button
  type="button"
  class="resize-handle"
  class:dragging
  class:vertical
  role="slider"
  aria-orientation={vertical ? 'vertical' : 'horizontal'}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuenow={value}
  aria-valuetext={valueText}
  aria-label={label}
  onpointerdown={start}
  onpointermove={move}
  onpointerup={finish}
  onpointercancel={finish}
  onkeydown={keydown}
></button>

<style>
  .resize-handle {
    appearance: none;
    background: transparent;
    border: 0;
    cursor: col-resize;
    height: 100%;
    padding: 0;
    position: absolute;
    top: 0;
    touch-action: none;
    user-select: none;
    width: 0.5rem;
  }

  .resize-handle.vertical {
    cursor: row-resize;
    height: 0.5rem;
    left: 0;
    top: auto;
    width: 100%;
  }

  .resize-handle:hover,
  .resize-handle.dragging,
  .resize-handle:focus-visible {
    background: var(--primary-main);
  }

  .resize-handle:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: -3px;
  }
</style>
