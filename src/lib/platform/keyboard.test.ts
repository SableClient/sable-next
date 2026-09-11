import { afterEach, expect, test, vi } from 'vitest';
import { trackKeyboardInset } from './keyboard';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.tauriOs;
  document.documentElement.style.removeProperty('--keyboard-height');
});

test.each(['ios', 'android'])(
  '%s viewport changes preserve the native keyboard inset',
  async (os) => {
    vi.useFakeTimers();
    const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
    vi.stubGlobal('visualViewport', viewport);
    vi.stubGlobal('innerHeight', 800);
    document.documentElement.dataset.tauriOs = os;
    document.documentElement.style.setProperty('--keyboard-height', '300px');
    const stop = trackKeyboardInset();
    try {
      expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
      viewport.height = 780;
      viewport.dispatchEvent(new Event('resize'));
      viewport.dispatchEvent(new Event('scroll'));
      await vi.runAllTimersAsync();
      expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
    } finally {
      stop();
    }
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
  }
);

test('browsers track keyboard geometry and clean up pending updates', async () => {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  const stop = trackKeyboardInset();
  expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
  viewport.offsetTop = 20;
  viewport.dispatchEvent(new Event('scroll'));
  await vi.runAllTimersAsync();
  expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('280px');
  viewport.height = 800;
  viewport.offsetTop = 0;
  viewport.dispatchEvent(new Event('resize'));
  await vi.runAllTimersAsync();
  expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');
  viewport.dispatchEvent(new Event('resize'));
  stop();
  viewport.dispatchEvent(new Event('scroll'));
  await vi.runAllTimersAsync();
  expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('');
});

test('pinch zoom and panning do not become keyboard insets', async () => {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), { height: 400, offsetTop: 100, scale: 2 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  const stop = trackKeyboardInset();
  expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');
  viewport.height = 250;
  viewport.dispatchEvent(new Event('resize'));
  await vi.runAllTimersAsync();
  expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
  viewport.offsetTop = 200;
  viewport.dispatchEvent(new Event('scroll'));
  await vi.runAllTimersAsync();
  expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
  viewport.height = 400;
  viewport.dispatchEvent(new Event('resize'));
  await vi.runAllTimersAsync();
  expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');
  stop();
});
