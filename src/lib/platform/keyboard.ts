import { on } from 'svelte/events';

import { isEditableTarget } from '#lib/ui/shortcuts/binding.js';
import { startSwipeGesture, updateSwipeGesture, type SwipeGesture } from '#lib/ui/swipe-gesture.js';

import { hasIosKeyboardContextQuirk } from './input.js';

export function dismissKeyboardOnScroll(node: HTMLElement): () => void {
  let gesture: SwipeGesture | undefined;
  let field: HTMLElement | null = null;

  const reset = (): void => {
    gesture = undefined;
    field = null;
  };
  const start = (event: TouchEvent): void => {
    reset();
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !isEditableTarget(active) || node.contains(active))
      return;
    field = active;
    gesture = startSwipeGesture(event, 0);
  };
  const move = (event: TouchEvent): void => {
    if (!gesture) return;
    const update = updateSwipeGesture(gesture, event);
    if (update?.mode === 'pending') return;
    if (update?.mode === 'vertical' && !event.defaultPrevented && field === document.activeElement)
      field?.blur();
    reset();
  };

  const stop = [
    on(node, 'touchstart', start, { passive: true }),
    on(node, 'touchmove', move, { passive: true }),
    on(node, 'touchend', reset, { passive: true }),
    on(node, 'touchcancel', reset, { passive: true }),
  ];
  return () => {
    for (const off of stop) off();
    reset();
  };
}

export function keepKeyboardOnTap(node: HTMLElement): () => void {
  let touchedAt = -Infinity;

  const touched = (): void => {
    touchedAt = performance.now();
  };
  const press = (event: MouseEvent): void => {
    if (performance.now() - touchedAt > 1000) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !isEditableTarget(active) || node.contains(active))
      return;
    const target = event.target;
    if (target instanceof HTMLElement && (isEditableTarget(target) || target.closest('label')))
      return;
    event.preventDefault();
  };

  const stop = [on(node, 'touchend', touched, { passive: true }), on(node, 'mousedown', press)];
  return () => {
    for (const off of stop) off();
  };
}

function keyboardInset(viewport: VisualViewport): number {
  const scale = viewport.scale || 1;
  const offset = scale === 1 ? viewport.offsetTop : 0;
  return Math.max(0, Math.round(window.innerHeight - (viewport.height * scale + offset)));
}

export function resetDocumentScroll(): void {
  const scroller = document.scrollingElement;
  if (!scroller || window.scrollY === 0) return;
  if (scroller.scrollHeight > scroller.clientHeight + 1) return;
  window.scrollTo(0, 0);
}

function revealFocusedField(viewport: VisualViewport): void {
  const scroller = document.scrollingElement;
  const field = document.activeElement;
  if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return;
  if (!(field instanceof HTMLElement) || !field.matches('input, textarea, [contenteditable]'))
    return;
  const { top, bottom } = field.getBoundingClientRect();
  const visibleTop = viewport.offsetTop;
  const visibleBottom = visibleTop + viewport.height;
  if (top >= visibleTop && bottom <= visibleBottom) return;
  window.scrollBy(0, (top + bottom - visibleTop - visibleBottom) / 2);
}

export function trackKeyboardInset(): () => void {
  const os = document.documentElement.dataset.tauriOs;
  // Android resizes the native webview for the IME. iOS overlays it instead,
  // so viewport-fixed surfaces need VisualViewport's keyboard inset.
  if (os === 'android') return () => {};

  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const opensWithoutResize = os === 'ios' || hasIosKeyboardContextQuirk();
  let frame = 0;
  let settleFrame = 0;
  let last = -1;

  const write = (): void => {
    frame = 0;
    resetDocumentScroll();
    const inset = keyboardInset(viewport);
    if (inset === last) return;
    last = inset;
    document.documentElement.style.setProperty('--keyboard-height', `${String(inset)}px`);
  };

  const schedule = (): void => {
    if (frame) return;
    frame = requestAnimationFrame(write);
  };

  const settle = (): void => {
    if (!opensWithoutResize) return;
    cancelAnimationFrame(settleFrame);
    const until = performance.now() + 1000;
    const step = (): void => {
      write();
      if (performance.now() < until) {
        settleFrame = requestAnimationFrame(step);
      } else {
        settleFrame = 0;
        revealFocusedField(viewport);
      }
    };
    settleFrame = requestAnimationFrame(step);
  };

  write();
  const stopResize = on(viewport, 'resize', schedule);
  const stopScroll = on(viewport, 'scroll', schedule);
  const stopWindowScroll = on(window, 'scroll', schedule);
  const stopFocusIn = on(window, 'focusin', settle);
  const stopFocusOut = on(window, 'focusout', settle);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    cancelAnimationFrame(settleFrame);
    stopResize();
    stopScroll();
    stopWindowScroll();
    stopFocusIn();
    stopFocusOut();
    document.documentElement.style.removeProperty('--keyboard-height');
  };
}
