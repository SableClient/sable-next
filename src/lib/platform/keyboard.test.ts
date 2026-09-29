import { afterEach, expect, test, vi } from 'vitest';
import { resetDocumentScroll, trackKeyboardInset } from './keyboard';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.tauriOs;
  document.documentElement.style.removeProperty('--keyboard-height');
});

test('Android viewport changes preserve the native keyboard inset', async () => {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  document.documentElement.dataset.tauriOs = 'android';
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
});

test('iOS viewport changes update the keyboard inset for fixed surfaces', async () => {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  document.documentElement.dataset.tauriOs = 'ios';
  const stop = trackKeyboardInset();
  try {
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
    viewport.height = 520;
    viewport.dispatchEvent(new Event('resize'));
    await vi.runAllTimersAsync();
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('280px');
  } finally {
    stop();
  }
  expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('');
});

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

test('a document offset the shell cannot scroll back is zeroed', () => {
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('scrollY', 120);
  Object.defineProperty(document, 'scrollingElement', {
    value: { scrollHeight: 800, clientHeight: 800 },
    configurable: true,
  });
  try {
    resetDocumentScroll();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  } finally {
    delete (document as { scrollingElement?: unknown }).scrollingElement;
  }
});

test('a document that genuinely scrolls keeps its offset', () => {
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('scrollY', 120);
  Object.defineProperty(document, 'scrollingElement', {
    value: { scrollHeight: 2000, clientHeight: 800 },
    configurable: true,
  });
  try {
    resetDocumentScroll();
    expect(scrollTo).not.toHaveBeenCalled();
  } finally {
    delete (document as { scrollingElement?: unknown }).scrollingElement;
  }
});

test('a window scroll event zeroes a wedged document offset', async () => {
  vi.useFakeTimers();
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  vi.stubGlobal('scrollY', 0);
  const viewport = Object.assign(new EventTarget(), { height: 500, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  Object.defineProperty(document, 'scrollingElement', {
    value: { scrollHeight: 800, clientHeight: 800 },
    configurable: true,
  });
  const stop = trackKeyboardInset();
  try {
    vi.stubGlobal('scrollY', 40);
    window.dispatchEvent(new Event('scroll'));
    await vi.runAllTimersAsync();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  } finally {
    stop();
    delete (document as { scrollingElement?: unknown }).scrollingElement;
  }
});
