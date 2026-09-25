import type { Attachment } from 'svelte/attachments';

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Corner {
  width: number;
  height: number;
  gap: number;
  rtl: boolean;
}

export function fitsBesideContent(
  rects: readonly Box[],
  frame: Box,
  bottom: number,
  corner: Corner
): boolean {
  const full = frame.right - frame.left - 1;
  const top = bottom - corner.height;
  const edge = corner.rtl
    ? frame.left + corner.width + corner.gap
    : frame.right - corner.width - corner.gap;
  return rects.every((rect) => {
    if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) return true;
    if (rect.right - rect.left >= full) return true;
    if (rect.bottom <= top) return true;
    return corner.rtl ? rect.left >= edge : rect.right <= edge;
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
      const frame = node.getBoundingClientRect();
      const bottom = main.getBoundingClientRect().bottom;
      const size = badge.getBoundingClientRect();
      const style = getComputedStyle(badge);
      onFit(
        fitsBesideContent(rects, frame, bottom, {
          width: size.width,
          height: size.height,
          gap: Number.parseFloat(style.marginInlineStart) || 0,
          rtl: style.direction === 'rtl',
        })
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
