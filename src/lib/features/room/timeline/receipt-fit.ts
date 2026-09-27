import type { Attachment } from 'svelte/attachments';

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function fitsBesideContent(
  rects: readonly Box[],
  column: Box,
  badge: Box,
  gap: number,
  rtl: boolean
): boolean {
  const full = column.right - column.left - 1;
  const top = column.bottom - (badge.bottom - badge.top);
  const edge = rtl ? badge.right + gap : badge.left - gap;
  return rects.every((rect) => {
    if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return true;
    if (rect.right - rect.left >= full) return true;
    if (rect.bottom <= top) return true;
    return rtl ? rect.left >= edge : rect.right <= edge;
  });
}

export function trailingReceipt(onFit: (fits: boolean) => void): Attachment<HTMLElement> {
  return (node) => {
    const measure = () => {
      const main = node.querySelector('.message-main');
      const badge = node.querySelector('.receipt-slot');
      if (!main || !badge) return;
      const range = document.createRange();
      range.selectNodeContents(main);
      const rects = [...range.getClientRects()];
      const style = getComputedStyle(badge);
      onFit(
        fitsBesideContent(
          rects,
          main.getBoundingClientRect(),
          badge.getBoundingClientRect(),
          Number.parseFloat(style.marginInlineStart) || 0,
          style.direction === 'rtl'
        )
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const main = node.querySelector('.message-main');
    if (main) observer.observe(main);
    const badge = node.querySelector('.receipt-slot');
    if (badge) observer.observe(badge);
    return () => {
      observer.disconnect();
    };
  };
}
