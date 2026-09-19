import { createAttachmentKey } from 'svelte/attachments';

const depths = new Set<number>();
let element: HTMLStyleElement | null = null;
let openSurfaces = 0;
let top = 0;

function raise(depth: number): void {
  if (depths.has(depth)) return;
  depths.add(depth);
  element ??= document.head.appendChild(document.createElement('style'));
  element.textContent += `[data-overlay-depth="${String(depth)}"] { z-index: calc(var(--layer-overlay) + ${String(depth)}); }\n`;
}

export function overlayLayer(): Record<symbol, (node: Element) => () => void> {
  return {
    [createAttachmentKey()]: (node: Element) => {
      openSurfaces += 1;
      top += 1;
      raise(top);
      node.setAttribute('data-overlay-depth', String(top));

      return () => {
        openSurfaces -= 1;
        if (openSurfaces === 0) top = 0;
      };
    },
  };
}
