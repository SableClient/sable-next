import { on } from 'svelte/events';

import type { CallVideoOverlay } from './call-transport';
import { ignoreError } from './call-transport';

function hidden(slot: Element, rect: DOMRect): boolean {
  if (rect.width <= 0 || rect.height <= 0) return true;
  if (rect.right < 0 || rect.bottom < 0) return true;
  if (rect.left > window.innerWidth || rect.top > window.innerHeight) return true;
  const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return top === null || (top !== slot && !slot.contains(top));
}

export function nativeVideoSlot(overlay: CallVideoOverlay): (slot: HTMLElement) => () => void {
  return (slot) => {
    let placed = '';

    const report = (): void => {
      if (document.visibilityState !== 'visible') return;
      const rect = slot.getBoundingClientRect();
      if (hidden(slot, rect)) {
        if (placed === '') return;
        placed = '';
        overlay.clear().catch(ignoreError);
        return;
      }
      const key = [rect.x, rect.y, rect.width, rect.height].map(Math.round).join(',');
      if (key === placed) return;
      placed = key;
      overlay
        .place({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          devicePixelRatio: window.devicePixelRatio || 1,
        })
        .catch(ignoreError);
    };

    report();
    const resize = new ResizeObserver(report);
    resize.observe(slot);
    const intersection = new IntersectionObserver(report, { threshold: [0, 0.25, 0.5, 0.75, 1] });
    intersection.observe(slot);
    const mutation = new MutationObserver(report);
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    const offResize = on(window, 'resize', report);
    const offScroll = on(document, 'scroll', report, { capture: true, passive: true });

    return () => {
      resize.disconnect();
      intersection.disconnect();
      mutation.disconnect();
      offResize();
      offScroll();
      overlay.clear().catch(ignoreError);
    };
  };
}
