import { on } from 'svelte/events';

import { hasIosKeyboardContextQuirk } from './input.js';

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
