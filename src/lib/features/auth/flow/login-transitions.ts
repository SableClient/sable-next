import { cubicInOut } from 'svelte/easing';

interface TransitionOptions {
  duration: number;
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function smoothSlide(node: HTMLElement, { duration }: TransitionOptions) {
  const style = getComputedStyle(node);
  const height = node.getBoundingClientRect().height;
  const paddingTop = pixels(style.paddingTop);
  const paddingBottom = pixels(style.paddingBottom);
  const marginTop = pixels(style.marginTop);
  const marginBottom = pixels(style.marginBottom);
  const rowGap = pixels(style.rowGap);
  const columnGap = pixels(style.columnGap);
  const borderTopWidth = pixels(style.borderTopWidth);
  const borderRightWidth = pixels(style.borderRightWidth);
  const borderBottomWidth = pixels(style.borderBottomWidth);
  const borderLeftWidth = pixels(style.borderLeftWidth);

  return {
    duration,
    easing: cubicInOut,
    css: (t: number) => `
      overflow: hidden;
      opacity: ${String(t)};
      height: ${String(t * height)}px;
      padding-top: ${String(t * paddingTop)}px;
      padding-bottom: ${String(t * paddingBottom)}px;
      margin-top: ${String(t * marginTop)}px;
      margin-bottom: ${String(t * marginBottom)}px;
      row-gap: ${String(t * rowGap)}px;
      column-gap: ${String(t * columnGap)}px;
      border-top-width: ${String(t * borderTopWidth)}px;
      border-right-width: ${String(t * borderRightWidth)}px;
      border-bottom-width: ${String(t * borderBottomWidth)}px;
      border-left-width: ${String(t * borderLeftWidth)}px;
      min-height: 0;
    `,
  };
}
