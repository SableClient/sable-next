const HEIGHT_EPSILON = 1;
const TRAILING_SPACE_SENTINEL = '\u200B';

const COPIED_PROPERTIES = [
  'fontFamily',
  'fontSize',
  'fontStretch',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontFeatureSettings',
  'fontKerning',
  'fontOpticalSizing',
  'fontVariationSettings',
  'letterSpacing',
  'lineHeight',
  'tabSize',
  'textIndent',
  'textTransform',
] as const;

const lineHeights = new WeakMap<HTMLElement, { key: string; height: number }>();

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
  if (width <= 0) return row.clientWidth > 0;

  const style = getComputedStyle(editable);
  const copied = COPIED_PROPERTIES.map((property) => style[property]);
  const key = [...copied, (document.fonts as FontFaceSet | undefined)?.status].join('\n');
  let line = lineHeights.get(measurer);
  if (line?.key !== key) {
    COPIED_PROPERTIES.forEach((property, index) => {
      measurer.style[property] = copied[index];
    });
    measurer.style.width = 'max-content';
    measurer.textContent = 'M';
    line = { key, height: measurer.scrollHeight };
    lineHeights.set(measurer, line);
  }

  measurer.style.width = `${String(width)}px`;
  measurer.textContent = /[ \t]$/.test(text) ? `${text}${TRAILING_SPACE_SENTINEL}` : text;

  return measurer.scrollHeight > line.height + HEIGHT_EPSILON;
}
