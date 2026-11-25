import type { Attachment } from 'svelte/attachments';

// Text clipped inside a block, like a collapsed code block, would pass for the last line.
function trailingBlock(space: Element): Element | null {
  let current = space.previousSibling;
  while (current) {
    if (current instanceof Element) {
      const display = getComputedStyle(current).display;
      if (display !== 'none') {
        if (!display.startsWith('inline') && display !== 'contents') return current;
        if (!current.lastChild) return null;
        current = current.lastChild;
        continue;
      }
    } else if (current instanceof Text && current.data.trim()) {
      return null;
    }
    current = current.previousSibling;
  }
  return null;
}

function lastLineRunsBackwards(node: HTMLElement): boolean {
  const space = node.querySelector('.receipt-space');
  if (!space) return false;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEndBefore(space);
  const last =
    trailingBlock(space)?.getBoundingClientRect() ??
    [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).at(-1);
  const box = space.getBoundingClientRect();
  if (last === undefined || box.width === 0 || box.top >= last.bottom - 1) return false;
  const endsLeft = box.right <= last.left + 1;
  const endsRight = box.left >= last.right - 1;
  const rtl = getComputedStyle(node).direction === 'rtl';
  return rtl ? endsRight : endsLeft;
}

// Flipping moves only the absolutely positioned badge, so it never resizes what it measures.
export const receiptReserve: Attachment<HTMLElement> = (node) => {
  const measure = () => {
    node.toggleAttribute('data-receipt-flip', lastLineRunsBackwards(node));
  };
  const observer = new ResizeObserver(measure);
  observer.observe(node);
  const space = node.querySelector('.receipt-space');
  if (space) observer.observe(space);
  return () => {
    observer.disconnect();
    node.removeAttribute('data-receipt-flip');
  };
};
