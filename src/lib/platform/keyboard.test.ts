import { afterEach, expect, onTestFinished, test, vi } from 'vitest';
import {
  dismissKeyboardOnScroll,
  keepKeyboardOnTap,
  resetDocumentScroll,
  trackKeyboardInset,
} from './keyboard';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.tauriOs;
  document.documentElement.style.removeProperty('--keyboard-height');
});

async function scrollKeyboardHarness() {
  const node = document.createElement('div');
  const field = document.createElement('textarea');
  field.value = 'Unsent draft';
  document.body.append(node, field);
  field.focus();
  const stop = dismissKeyboardOnScroll(node);
  await Promise.resolve();
  onTestFinished(() => {
    stop();
    node.remove();
    field.remove();
  });
  const touch = (type: string, x = 0, y = 0, count = 1, target: HTMLElement = node): Event => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
      value: Array.from({ length: count }, () => ({ clientX: x, clientY: y })),
    });
    target.dispatchEvent(event);
    return event;
  };
  return { node, field, touch };
}

test.each([-30, 30])('vertical touch scrolling dismisses the keyboard (%i)', async (distance) => {
  const { field, touch } = await scrollKeyboardHarness();
  touch('touchstart');
  const event = touch('touchmove', 2, distance);
  expect(document.activeElement).not.toBe(field);
  expect(field.value).toBe('Unsent draft');
  expect(event.defaultPrevented).toBe(false);
});

test('taps, small movements, and horizontal swipes preserve composer focus', async () => {
  const { field, touch } = await scrollKeyboardHarness();
  touch('touchstart');
  touch('touchend', 0, 0, 0);
  expect(field).toBe(document.activeElement);
  touch('touchstart');
  touch('touchmove', 1, 3);
  expect(field).toBe(document.activeElement);
  touch('touchmove', 30, 4);
  touch('touchmove', 30, 60);
  expect(field).toBe(document.activeElement);
});

test.each(['touchend', 'touchcancel'])('%s clears the pending keyboard dismissal', async (type) => {
  const { field, touch } = await scrollKeyboardHarness();
  touch('touchstart');
  touch(type, 0, 0, 0);
  touch('touchmove', 0, 30);
  expect(field).toBe(document.activeElement);
});

test('multi-touch gestures preserve composer focus', async () => {
  const { field, touch } = await scrollKeyboardHarness();
  touch('touchstart', 0, 0, 2);
  touch('touchmove', 0, 30, 2);
  expect(field).toBe(document.activeElement);
  touch('touchstart');
  touch('touchmove', 0, 30, 2);
  touch('touchmove', 0, 60);
  expect(field).toBe(document.activeElement);
});

test('scrolling inside an editor preserves its focus', async () => {
  const { node, field, touch } = await scrollKeyboardHarness();
  node.append(field);
  field.focus();
  touch('touchstart', 0, 0, 1, field);
  touch('touchmove', 0, 30, 1, field);
  expect(field).toBe(document.activeElement);
});

test('a focus change during a touch gesture does not blur the new field', async () => {
  const { node, touch } = await scrollKeyboardHarness();
  const other = document.createElement('input');
  node.append(other);
  touch('touchstart');
  other.focus();
  touch('touchmove', 0, 30);
  expect(other).toBe(document.activeElement);
});

test('blocked touch scrolling preserves composer focus', async () => {
  const { node, field, touch } = await scrollKeyboardHarness();
  const child = document.createElement('div');
  node.append(child);
  child.addEventListener('touchmove', (event) => {
    event.preventDefault();
  });
  touch('touchstart', 0, 0, 1, child);
  touch('touchmove', 0, 30, 1, child);
  expect(field).toBe(document.activeElement);
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

test('a focus change keeps measuring while the keyboard opens without a resize', async () => {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  document.documentElement.dataset.tauriOs = 'ios';
  const stop = trackKeyboardInset();
  try {
    window.dispatchEvent(new FocusEvent('focusin'));
    await vi.advanceTimersByTimeAsync(100);
    viewport.height = 500;
    await vi.advanceTimersByTimeAsync(400);
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('300px');
  } finally {
    stop();
  }
});

test('a focus change on desktop does not keep measuring', async () => {
  vi.useFakeTimers();
  const viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 800);
  const stop = trackKeyboardInset();
  try {
    window.dispatchEvent(new FocusEvent('focusin'));
    await vi.advanceTimersByTimeAsync(100);
    viewport.height = 500;
    await vi.advanceTimersByTimeAsync(400);
    expect(document.documentElement.style.getPropertyValue('--keyboard-height')).toBe('0px');
  } finally {
    stop();
  }
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

async function tapKeyboardHarness() {
  const node = document.createElement('div');
  const button = document.createElement('button');
  const input = document.createElement('input');
  const field = document.createElement('textarea');
  node.append(button, input);
  document.body.append(node, field);
  field.focus();
  const stop = keepKeyboardOnTap(node);
  await Promise.resolve();
  onTestFinished(() => {
    stop();
    node.remove();
    field.remove();
  });
  const tap = (target: HTMLElement, touch = true): MouseEvent => {
    if (touch) target.dispatchEvent(new Event('touchend', { bubbles: true }));
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  return { node, button, input, field, tap };
}

test('tapping the timeline keeps the composer focused', async () => {
  const { node, button, tap } = await tapKeyboardHarness();
  expect(tap(node).defaultPrevented).toBe(true);
  expect(tap(button).defaultPrevented).toBe(true);
});

test('mouse presses and taps on editable fields move focus as usual', async () => {
  const { node, input, tap } = await tapKeyboardHarness();
  expect(tap(node, false).defaultPrevented).toBe(false);
  expect(tap(input).defaultPrevented).toBe(false);
});

test('taps without a focused field outside the timeline are left alone', async () => {
  const { node, field, tap } = await tapKeyboardHarness();
  field.blur();
  expect(tap(node).defaultPrevented).toBe(false);
});
