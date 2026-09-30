import type { Attachment } from 'svelte/attachments';

function spacerStandsAlone(node: HTMLElement): boolean {
  const space = node.querySelector('.receipt-space');
  if (!space) return false;
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEndBefore(space);
  const last = [...range.getClientRects()]
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .at(-1);
  const box = space.getBoundingClientRect();
  return last !== undefined && box.width > 0 && box.top >= last.bottom - 1;
}

export const receiptReserve: Attachment<HTMLElement> = (node) => {
  const measure = () => {
    delete node.dataset.receiptNarrow;
    if (spacerStandsAlone(node)) node.dataset.receiptNarrow = '';
  };
  const observer = new ResizeObserver(measure);
  observer.observe(node);
  return () => {
    observer.disconnect();
    delete node.dataset.receiptNarrow;
  };
};
