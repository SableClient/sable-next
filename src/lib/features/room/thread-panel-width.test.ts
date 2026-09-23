import { expect, test } from 'vitest';

import {
  clampThreadPanelWidth,
  MAX_THREAD_PANEL_WIDTH,
  MIN_THREAD_PANEL_WIDTH,
  remFromPointerDelta,
} from './thread-panel-width';

test('keeps the thread pane within its usable range', () => {
  expect(clampThreadPanelWidth(MIN_THREAD_PANEL_WIDTH - 1)).toBe(MIN_THREAD_PANEL_WIDTH);
  expect(clampThreadPanelWidth(MAX_THREAD_PANEL_WIDTH + 1)).toBe(MAX_THREAD_PANEL_WIDTH);
  expect(clampThreadPanelWidth(35)).toBe(35);
});

test('converts pointer movement into root-relative width changes', () => {
  expect(remFromPointerDelta(80, 16)).toBe(5);
});
