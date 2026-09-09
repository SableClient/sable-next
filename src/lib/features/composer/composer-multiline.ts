const HEIGHT_EPSILON = 1;
const TRAILING_SPACE_SENTINEL = '\u200B';

const COPIED_PROPERTIES = [
  'font',
  'fontFeatureSettings',
  'fontKerning',
  'fontVariationSettings',
  'letterSpacing',
  'lineHeight',
  'tabSize',
  'textIndent',
  'textTransform',
] as const;

export interface MultilineMeasure {
  text: string;
  row: HTMLElement;
  before: HTMLElement | undefined;
  after: HTMLElement | undefined;
  editable: HTMLElement;
  measurer: HTMLElement;
}

function px(value: string): number {
  return Number.parseFloat(value) || 0;
}

function inlineTextWidth(
  row: HTMLElement,
  editable: HTMLElement,
  before: HTMLElement | undefined,
  after: HTMLElement | undefined
): number {
  const style = getComputedStyle(row);
  const gap = px(style.columnGap);
  let width = row.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
  if (before) width -= before.offsetWidth + gap;
  if (after) width -= after.offsetWidth + gap;

  for (let node: HTMLElement | null = editable; node && node !== row; node = node.parentElement) {
    const box = getComputedStyle(node);
    width -=
      px(box.paddingLeft) +
      px(box.paddingRight) +
      px(box.borderLeftWidth) +
      px(box.borderRightWidth);
  }

  return width;
}

export function isMultiline({
  text,
  row,
  before,
  after,
  editable,
  measurer,
}: MultilineMeasure): boolean {
  if (text.includes('\n')) return true;
  if (text.length === 0) return false;

  const width = inlineTextWidth(row, editable, before, after);
  if (width <= 0) return false;

  const style = getComputedStyle(editable);
  for (const property of COPIED_PROPERTIES) measurer.style[property] = style[property];

  measurer.style.width = 'max-content';
  measurer.textContent = 'M';
  const line = measurer.scrollHeight;

  measurer.style.width = `${String(width)}px`;
  measurer.textContent = /[ \t]$/.test(text) ? `${text}${TRAILING_SPACE_SENTINEL}` : text;

  return measurer.scrollHeight > line + HEIGHT_EPSILON;
}
