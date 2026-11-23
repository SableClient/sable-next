import type { Attachment } from 'svelte/attachments';

const MIN_THUMB_PX = 24;

/** Moves `thumb` as the scrollbar of the element, drawn over its edge instead of beside it,
    whatever the platform's scrollbars do. The element hides its own scrollbar, and the thumb is
    positioned against the element's offset parent. */
export const overlayScrollbar =
  (thumb: HTMLElement | undefined): Attachment<HTMLElement> =>
  (element) => {
    if (!thumb) return;
    let height = 0;
    const range = (): number => element.scrollHeight - element.clientHeight;

    const update = (): void => {
      thumb.hidden = range() <= 0;
      if (thumb.hidden) return;
      const track = element.clientHeight;
      height = Math.max((track / element.scrollHeight) * track, MIN_THUMB_PX);
      const top = element.offsetTop + (element.scrollTop / range()) * (track - height);
      thumb.style.height = `${height}px`;
      thumb.style.transform = `translateY(${top}px)`;
    };

    let drag: { pointer: number; y: number; scrollTop: number } | null = null;
    const pointerdown = (event: PointerEvent): void => {
      drag = { pointer: event.pointerId, y: event.clientY, scrollTop: element.scrollTop };
      thumb.setPointerCapture(event.pointerId);
    };
    const pointermove = (event: PointerEvent): void => {
      if (drag?.pointer !== event.pointerId) return;
      const perPixel = range() / (element.clientHeight - height);
      element.scrollTop = drag.scrollTop + (event.clientY - drag.y) * perPixel;
    };
    const pointerup = (): void => {
      drag = null;
    };

    // Content changes far more often than its size, so only sizes trigger a layout read.
    const resize = new ResizeObserver(update);
    const observeChildren = (): void => {
      resize.disconnect();
      resize.observe(element);
      for (const child of element.children) resize.observe(child);
    };
    const mutation = new MutationObserver(observeChildren);
    mutation.observe(element, { childList: true });
    observeChildren();
    element.addEventListener('scroll', update, { passive: true });
    thumb.addEventListener('pointerdown', pointerdown);
    thumb.addEventListener('pointermove', pointermove);
    thumb.addEventListener('pointerup', pointerup);
    thumb.addEventListener('pointercancel', pointerup);
    update();

    return () => {
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener('scroll', update);
      thumb.removeEventListener('pointerdown', pointerdown);
      thumb.removeEventListener('pointermove', pointermove);
      thumb.removeEventListener('pointerup', pointerup);
      thumb.removeEventListener('pointercancel', pointerup);
    };
  };
