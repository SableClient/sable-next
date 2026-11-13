import type { Attachment } from 'svelte/attachments';

function spacerPlacement(node: HTMLElement): 'alone' | 'flip' | null {
  const space = node.querySelector('.receipt-space');
  if (!space) return null;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEndBefore(space);
  const last = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .at(-1);
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
  return () => {
    observer.disconnect();
    delete node.dataset.receiptNarrow;
    delete node.dataset.receiptFlip;
  };
};
