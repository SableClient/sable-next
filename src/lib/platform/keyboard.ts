import { on } from 'svelte/events';

function keyboardInset(viewport: VisualViewport): number {
  const scale = viewport.scale || 1;
  const offset = scale === 1 ? viewport.offsetTop : 0;
  return Math.max(0, Math.round(window.innerHeight - (viewport.height * scale + offset)));
}

// Inner containers do the app's scrolling, so a nonzero document offset is a
// WebKit keyboard-reveal side effect that touch panning cannot undo. Zero it.
export function resetDocumentScroll(): void {
  const scroller = document.scrollingElement;
  if (!scroller || window.scrollY === 0) return;
  if (scroller.scrollHeight > scroller.clientHeight + 1) return;
  window.scrollTo(0, 0);
}

export function trackKeyboardInset(): () => void {
  const os = document.documentElement.dataset.tauriOs;
  // Android resizes the native webview for the IME. iOS overlays it instead,
  // so viewport-fixed surfaces need VisualViewport's keyboard inset.
  if (os === 'android') return () => {};

  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  let frame = 0;
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

  write();
  const stopResize = on(viewport, 'resize', schedule);
  const stopScroll = on(viewport, 'scroll', schedule);
  const stopWindowScroll = on(window, 'scroll', schedule);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    stopResize();
    stopScroll();
    stopWindowScroll();
    document.documentElement.style.removeProperty('--keyboard-height');
  };
}
