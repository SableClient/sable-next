// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { blockEdgeNavigation } from './edge-navigation';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  document.body.replaceChildren();
});

function touchAt(target: Element, pageX: number): Event {
  const event = new Event('touchstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: [{ pageX }] });
  target.dispatchEvent(event);
  return event;
}

function browserOn(userAgent: string): void {
  vi.mocked(isTauri).mockReturnValue(false);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(5);
}

test('a touch at either edge of iOS Safari cannot start a navigation swipe', async () => {
  browserOn(IPHONE);
  const text = document.createElement('p');
  document.body.append(text);
  const stop = blockEdgeNavigation();
  await Promise.resolve();

  expect(touchAt(text, 5).defaultPrevented).toBe(true);
  expect(touchAt(text, window.innerWidth - 5).defaultPrevented).toBe(true);
  expect(touchAt(text, window.innerWidth / 2).defaultPrevented).toBe(false);
  stop();
  expect(touchAt(text, 5).defaultPrevented).toBe(false);
});

test('a control at the edge still takes its tap', async () => {
  browserOn(IPHONE);
  const button = document.createElement('button');
  document.body.append(button);
  const stop = blockEdgeNavigation();
  await Promise.resolve();

  expect(touchAt(button, 5).defaultPrevented).toBe(false);
  stop();
});

test('the native app and other browsers are left alone', async () => {
  const text = document.createElement('p');
  document.body.append(text);

  browserOn('Mozilla/5.0 (Linux; Android 15) Chrome/140.0');
  const android = blockEdgeNavigation();
  await Promise.resolve();
  expect(touchAt(text, 5).defaultPrevented).toBe(false);
  android();

  browserOn(IPHONE);
  vi.mocked(isTauri).mockReturnValue(true);
  const native = blockEdgeNavigation();
  await Promise.resolve();
  expect(touchAt(text, 5).defaultPrevented).toBe(false);
  native();
});
