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

function spacerPlacement(node: HTMLElement): 'alone' | 'flip' | null {
  const space = node.querySelector('.receipt-space');
  if (!space) return null;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEndBefore(space);
  const last =
    trailingBlock(space)?.getBoundingClientRect() ??
    [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0).at(-1);
  const box = space.getBoundingClientRect();
  if (last === undefined || box.width === 0) return null;
  if (box.top >= last.bottom - 1) return 'alone';
  const endsLeft = box.right <= last.left + 1;
  const endsRight = box.left >= last.right - 1;
  const rtl = getComputedStyle(node).direction === 'rtl';
  return (rtl ? endsRight : endsLeft) ? 'flip' : null;
}

export const receiptReserve: Attachment<HTMLElement> = (node) => {
  const measure = () => {
    delete node.dataset.receiptNarrow;
    delete node.dataset.receiptFlip;
    const placement = spacerPlacement(node);
    if (placement === 'alone') node.dataset.receiptNarrow = '';
    if (placement === 'flip') node.dataset.receiptFlip = '';
  };
  const observer = new ResizeObserver(measure);
  observer.observe(node);
  const space = node.querySelector('.receipt-space');
  if (space) observer.observe(space);
  return () => {
    observer.disconnect();
    delete node.dataset.receiptNarrow;
    delete node.dataset.receiptFlip;
  };
};
