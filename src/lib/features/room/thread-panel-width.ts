export const MIN_THREAD_PANEL_WIDTH = 15.625;
export const MAX_THREAD_PANEL_WIDTH = 37.5;
export const THREAD_PANEL_WIDTH_STEP = 5;

export function clampThreadPanelWidth(width: number): number {
  return Math.max(MIN_THREAD_PANEL_WIDTH, Math.min(MAX_THREAD_PANEL_WIDTH, width));
}

export function remFromPointerDelta(delta: number, rootFontSize: number): number {
  return delta / rootFontSize;
}
