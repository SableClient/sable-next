import { expect } from 'vitest';

/** Asserts that `list` scrolls and nothing between it and its dialog frame does. */
export function expectScrollsInsideFrame(list: HTMLElement): void {
  const frame = list.closest('.dialog-content');
  expect(frame).not.toBeNull();
  for (let element = list.parentElement; element; element = element.parentElement) {
    expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight);
    if (element === frame) break;
  }
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
}
