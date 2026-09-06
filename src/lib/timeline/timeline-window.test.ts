// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { TimelineWindow, type TimelineRow } from './timeline-window';

const windows: TimelineWindow<number>[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const window of windows.splice(0)) window.destroy();
  vi.useRealTimers();
  document.body.replaceChildren();
});

function entries(count: number) {
  return Array.from({ length: count }, (_, value) => ({ key: String(value), value }));
}

function fixture(heightForRow?: (value: number) => number) {
  let rowHeight = 50;
  const size = (value: number) => heightForRow?.(value) ?? rowHeight;
  const viewport = document.createElement('div');
  const canvas = document.createElement('div');
  const content = document.createElement('div');
  viewport.append(canvas);
  canvas.append(content);
  document.body.append(viewport);
  Object.defineProperties(viewport, {
    clientHeight: { get: () => 300 },
    scrollHeight: { get: () => Number.parseFloat(canvas.style.height) || 300 },
  });
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 300, 300);
  let measuredHeight = 0;
  const contentHeight = () => (heightForRow ? measuredHeight : content.children.length * rowHeight);
  content.getBoundingClientRect = () => new DOMRect(0, 0, 300, contentHeight());
  const contentTop = () =>
    (Number.parseFloat(canvas.style.height) || 0) -
    Number.parseFloat(content.style.bottom || '0') -
    contentHeight();
  let pause: Promise<void> | undefined;
  const render = vi.fn(async (rows: readonly TimelineRow<number>[]) => {
    if (pause) await pause;
    const existing = new Map(
      Array.from(content.children).map((node) => [
        (node as HTMLElement).dataset.timelineKey,
        node as HTMLElement,
      ])
    );
    measuredHeight = 0;
    const nodes = rows.map((row, index) => {
      const measuredTop = measuredHeight;
      measuredHeight += size(row.value);
      const node = existing.get(row.key) ?? document.createElement('button');
      if (!existing.has(row.key)) node.textContent = row.key;
      node.dataset.timelineKey = row.key;
      node.getBoundingClientRect = () =>
        new DOMRect(
          0,
          contentTop() + (heightForRow ? measuredTop : index * rowHeight) - viewport.scrollTop,
          300,
          size(row.value)
        );
      return node;
    });
    for (const node of Array.from(content.children)) {
      if (!nodes.includes(node as HTMLElement)) node.remove();
    }
    nodes.forEach((node, index) => {
      if (content.children[index] !== node)
        content.insertBefore(node, content.children[index] ?? null);
    });
  });
  const onChange = vi.fn();
  const window = new TimelineWindow({
    viewport,
    canvas,
    content,
    render,
    onChange,
    onScroll: vi.fn(),
  });
  windows.push(window);
  return {
    window,
    viewport,
    content,
    render,
    onChange,
    keys: () =>
      Array.from(content.children).map((node) => (node as HTMLElement).dataset.timelineKey),
    resize: (height: number) => {
      rowHeight = height;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    pause: () => {
      let resolve!: () => void;
      pause = new Promise<void>((done) => {
        resolve = done;
      });
      return () => {
        pause = undefined;
        resolve();
      };
    },
  };
}

test('renders a bounded latest window and jumps to a stable key', async () => {
  const { window, keys } = fixture();
  await window.update(entries(1000));
  expect(keys()).toHaveLength(80);
  expect(keys().at(-1)).toBe('999');
  expect(await window.jumpTo('20')).toBe(true);
  expect(keys()).toContain('20');
  expect(window.state.pinned).toBe(false);
  expect(await window.jumpTo('missing')).toBe(false);
  await window.jumpTo(null);
  expect(keys().at(-1)).toBe('999');
  expect(window.state.pinned).toBe(true);
});

test('a distant jump requested as smooth moves directly to its rendered destination', async () => {
  const { window, viewport } = fixture();
  const animate = vi.spyOn(viewport, 'scrollTo').mockImplementation(() => {});
  await window.update(entries(1000));
  await window.jumpTo('20');
  await window.jumpTo(null, 'start', true);
  expect(animate).not.toHaveBeenCalled();
  expect(window.state.lastVisible).toBe(999);
});

test('continuous upward scrolling reaches older rows whose measured heights exceed estimates', async () => {
  const { window, viewport } = fixture((value) => (value < 900 ? 200 : 20));
  await window.update(entries(1000));
  viewport.dispatchEvent(new Event('touchstart'));
  for (let step = 0; step < 800; step++) {
    viewport.scrollTop = Math.max(0, viewport.scrollTop - 250);
    viewport.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(0);
    if (window.state.firstVisible === 0) break;
  }
  expect(window.state.firstVisible).toBe(0);
});

test('reversing upward after a resize restores older content without correcting the downward drag', async () => {
  const { window, viewport, content, resize } = fixture();
  await window.update(entries(100));
  await window.jumpTo('0', 'start');
  let offset = viewport.scrollTop;
  const writes = vi.fn((value: number) => {
    offset = value;
  });
  Object.defineProperty(viewport, 'scrollTop', { get: () => offset, set: writes });
  const scroll = async (delta: number) => {
    offset = Math.max(0, offset + delta);
    viewport.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(0);
  };
  viewport.dispatchEvent(new Event('touchstart'));
  await scroll(400);
  resize(200);
  expect(writes).not.toHaveBeenCalled();
  const anchor = content.querySelector<HTMLElement>(
    `[data-timeline-key="${window.state.firstVisible}"]`
  );
  if (!anchor) throw new Error('missing visible anchor');
  const top = anchor.getBoundingClientRect().top;
  await scroll(-100);
  expect(writes).toHaveBeenCalled();
  expect(anchor.getBoundingClientRect().top - top).toBe(100);
  for (let step = 0; step < 20 && window.state.firstVisible !== 0; step++) await scroll(-200);
  expect(window.state.firstVisible).toBe(0);
});

test('fractional row heights keep the pinned content exactly at the viewport bottom', async () => {
  const { window, content, resize } = fixture();
  resize(50.13);
  await window.update(entries(100));
  expect(content.lastElementChild?.getBoundingClientRect().bottom).toBeCloseTo(300, 5);
  resize(50.27);
  expect(content.lastElementChild?.getBoundingClientRect().bottom).toBeCloseTo(300, 5);
});

test('coalesces updates during a gesture until scrolling has settled', async () => {
  const { window, viewport, keys, render } = fixture();
  await window.update(entries(100));
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
  await window.update(entries(101));
  await window.update(entries(102));
  expect(render).toHaveBeenCalledTimes(1);
  expect(keys()).not.toContain('101');
  await vi.advanceTimersByTimeAsync(160);
  expect(keys()).toContain('101');
  expect(window.state.scrolling).toBe(false);
});

test('an upward wheel gesture in a room that fits keeps following latest', async () => {
  const { window, viewport } = fixture();
  await window.update(entries(2));
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  await window.update(entries(20));
  await vi.advanceTimersByTimeAsync(160);
  expect(window.state.pinned).toBe(true);
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
});

test('a scrollbar jump outside the rendered range fills the destination', async () => {
  const { window, viewport } = fixture();
  await window.update(entries(1000));
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(0);
  expect(window.state.firstVisible).toBe(0);
});

test('a scrollbar seek retains focused content outside the destination', async () => {
  const { window, viewport, content } = fixture();
  await window.update(entries(1000));
  const focused = content.lastElementChild as HTMLElement;
  focused.focus();
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(0);
  expect(document.activeElement).toBe(focused);
  expect(window.state.firstVisible).toBe(0);
});

test('a scrollbar seek retains selected content outside the destination', async () => {
  const { window, viewport, content } = fixture();
  await window.update(entries(1000));
  const selected = content.lastElementChild as HTMLElement;
  const range = document.createRange();
  range.selectNodeContents(selected);
  const selection = document.getSelection();
  if (!selection) throw new Error('missing selection');
  selection.removeAllRanges();
  selection.addRange(range);
  viewport.scrollTop = 0;
  viewport.dispatchEvent(new Event('scroll'));
  await vi.advanceTimersByTimeAsync(0);
  expect(content.contains(selected)).toBe(true);
  expect(selection.toString()).toBe('999');
  expect(window.state.firstVisible).toBe(0);
});

test('applies the newest update that arrives during a render', async () => {
  const { window, pause, keys } = fixture();
  const release = pause();
  const first = window.update(entries(100));
  const second = window.update(entries(110));
  const third = window.update(entries(120));
  release();
  await Promise.all([first, second, third]);
  expect(keys().at(-1)).toBe('119');
});

test('the latest jump wins when a previous jump is still rendering', async () => {
  const { window, pause, keys } = fixture();
  await window.update(entries(1000));
  const release = pause();
  const first = window.jumpTo('0');
  const second = window.jumpTo('500');
  release();
  expect(await first).toBe(false);
  expect(await second).toBe(true);
  expect(keys()).toContain('500');
});

test('user input cancels a jump waiting for its rows', async () => {
  const { window, pause, viewport } = fixture();
  await window.update(entries(1000));
  const before = window.state;
  const release = pause();
  const jump = window.jumpTo('0');
  viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -20 }));
  release();
  expect(await jump).toBe(false);
  expect(window.state.scrolling).toBe(true);
  expect(window.state.firstVisible).toBe(before.firstVisible);
  expect(window.state.lastVisible).toBe(before.lastVisible);
});

test('retains focused content across incoming updates', async () => {
  const { window, content } = fixture();
  await window.update(entries(100));
  const focused = content.firstElementChild as HTMLElement;
  focused.focus();
  await window.update(entries(200));
  expect(document.activeElement).toBe(focused);
  expect(content.contains(focused)).toBe(true);
});

test('a touch drag cancelling a delayed jump preserves movement and leaves follow mode', async () => {
  const { window, pause, viewport } = fixture();
  await window.update(entries(1000));
  const release = pause();
  const jump = window.jumpTo('0');
  viewport.dispatchEvent(new Event('touchstart'));
  viewport.scrollTop -= 100;
  viewport.dispatchEvent(new Event('scroll'));
  release();
  expect(await jump).toBe(false);
  expect(window.state.firstVisible).toBe(992);
  expect(window.state.pinned).toBe(false);
});

test('scrolls to latest through resized newer rows without exhausting an estimated tail', async () => {
  const { window, viewport, resize } = fixture();
  await window.update(entries(1000));
  await window.jumpTo('0');
  viewport.dispatchEvent(new Event('touchstart'));
  resize(100);
  for (let step = 0; step < 1100; step++) {
    const maximum = viewport.scrollHeight - viewport.clientHeight;
    viewport.scrollTop = Math.min(maximum, viewport.scrollTop + 100);
    viewport.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(0);
  }
  const before = window.state.firstVisible;
  expect(window.state.lastVisible).toBe(999);
  const release = new Event('touchend');
  Object.defineProperty(release, 'touches', { value: [] });
  viewport.dispatchEvent(release);
  await vi.advanceTimersByTimeAsync(160);
  expect(window.state.firstVisible).toBe(before);
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
});

test('destroy prevents queued renders from publishing or writing offsets', async () => {
  const { window, pause, onChange, viewport } = fixture();
  const release = pause();
  const update = window.update(entries(100));
  window.destroy();
  release();
  await update;
  expect(onChange).not.toHaveBeenCalled();
  expect(viewport.scrollTop).toBe(0);
  expect(await window.jumpTo(null)).toBe(false);
});
