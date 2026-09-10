// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { TimelineWindow, type TimelineRow } from './timeline-window';

const windows: TimelineWindow<number>[] = [];
type Fixture = ReturnType<typeof fixture>;

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
  let viewportHeight = 300;
  const size = (value: number) => heightForRow?.(value) ?? rowHeight;
  const viewport = document.createElement('div');
  const canvas = document.createElement('div');
  const content = document.createElement('div');
  viewport.append(canvas);
  canvas.append(content);
  document.body.append(viewport);
  Object.defineProperties(viewport, {
    clientHeight: { get: () => viewportHeight },
    scrollHeight: {
      get: () => Math.max(Number.parseFloat(canvas.style.height) || 0, viewportHeight),
    },
  });
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 300, viewportHeight);
  let measuredHeight = 0;
  const contentHeight = () => (heightForRow ? measuredHeight : content.children.length * rowHeight);
  content.getBoundingClientRect = () => new DOMRect(0, 0, 300, contentHeight());
  const contentTop = () =>
    (Number.parseFloat(canvas.style.height) || 0) -
    Number.parseFloat(content.style.bottom || '0') -
    contentHeight();
  let pause: Promise<void> | undefined;
  let omittedKey: string | undefined;
  const render = vi.fn(async (rows: readonly TimelineRow<number>[]) => {
    if (pause) await pause;
    const existing = new Map(
      Array.from(content.children).map((node) => [
        (node as HTMLElement).dataset.timelineKey,
        node as HTMLElement,
      ])
    );
    measuredHeight = 0;
    const nodes = rows
      .filter((row) => row.key !== omittedKey)
      .map((row, index) => {
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
    omitRow: (key: string) => {
      omittedKey = key;
      Array.from(content.children)
        .find((node) => (node as HTMLElement).dataset.timelineKey === key)
        ?.remove();
    },
    viewport,
    content,
    render,
    onChange,
    keys: () =>
      Array.from(content.children).map((node) => (node as HTMLElement).dataset.timelineKey),
    resizeViewport: (height: number, notify = true) => {
      viewportHeight = height;
      viewport.scrollTop = Math.max(
        0,
        Math.min(viewport.scrollTop, viewport.scrollHeight - height)
      );
      if (notify) document.dispatchEvent(new Event('visibilitychange'));
    },
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

test.each([
  { height: 400, touching: false },
  { height: 600, touching: false },
  { height: 400, touching: true },
  { height: 600, touching: true },
])(
  'expanding the viewport to $height restores bottom state without a gap (touching: $touching)',
  async ({ height, touching }) => {
    const { window, viewport, content, resizeViewport } = fixture();
    await window.update(entries(10));
    viewport.scrollTop = 100;
    viewport.dispatchEvent(new Event('scroll'));
    await vi.advanceTimersByTimeAsync(200);
    expect(window.state.pinned).toBe(false);
    if (touching) viewport.dispatchEvent(new Event('touchstart'));
    let offset = viewport.scrollTop;
    const writes = vi.fn((value: number) => {
      offset = value;
    });
    Object.defineProperty(viewport, 'scrollTop', { get: () => offset, set: writes });
    resizeViewport(height);
    await vi.advanceTimersByTimeAsync(200);
    expect(window.state.pinned).toBe(true);
    expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBe(0);
    expect(content.lastElementChild?.getBoundingClientRect().bottom).toBe(height);
    expect(writes).toHaveBeenCalledTimes(1);
  }
);

test('expanding the viewport before reaching latest preserves the reader', async () => {
  const { window, content, resizeViewport } = fixture();
  await window.update(entries(100));
  await window.jumpTo('20', 'start');
  const anchor = content.querySelector('[data-timeline-key="20"]');
  if (!anchor) throw new Error('missing reader anchor');
  const top = anchor.getBoundingClientRect().top;
  resizeViewport(600);
  expect(window.state.pinned).toBe(false);
  expect(anchor.getBoundingClientRect().top).toBe(top);
});

test.each(['scroll', 'layout'] as const)(
  'returning from bottom overscroll stays pinned during %s',
  async (notification) => {
    const { window, viewport } = fixture();
    await window.update(entries(10));
    const bottom = viewport.scrollHeight - viewport.clientHeight;
    let offset = bottom;
    const writes = vi.fn((value: number) => {
      offset = value;
    });
    Object.defineProperty(viewport, 'scrollTop', { get: () => offset, set: writes });
    viewport.dispatchEvent(new Event('touchstart'));
    for (const offset of [bottom + 80, bottom + 40, bottom]) {
      viewport.scrollTop = offset;
      if (notification === 'layout') document.dispatchEvent(new Event('visibilitychange'));
      viewport.dispatchEvent(new Event('scroll'));
      expect(window.state.pinned).toBe(true);
    }
    expect(writes).toHaveBeenCalledTimes(3);
    viewport.dispatchEvent(new TouchEvent('touchend', { touches: [] }));
    await vi.advanceTimersByTimeAsync(200);
    expect(window.state.pinned).toBe(true);
    viewport.scrollTop = bottom - 20;
    viewport.dispatchEvent(new Event('scroll'));
    expect(window.state.pinned).toBe(false);
  }
);

test.each(['wheel', 'keydown'])(
  'upward %s without movement keeps following latest',
  async (type) => {
    const { window, viewport, keys } = fixture();
    await window.update(entries(10));
    viewport.dispatchEvent(
      type === 'wheel'
        ? new WheelEvent('wheel', { deltaY: -20 })
        : new KeyboardEvent('keydown', { key: 'ArrowUp' })
    );
    expect(window.state.pinned).toBe(true);
    await window.update(entries(11));
    await vi.advanceTimersByTimeAsync(200);
    expect(keys()).toContain('10');
    expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
    expect(window.state.pinned).toBe(true);
  }
);

test.each(['scroll', 'layout'])(
  'fractional scrolling preserves movement during %s',
  async (notification) => {
    const { window, viewport } = fixture();
    await window.update(entries(10));
    const bottom = viewport.scrollHeight - viewport.clientHeight;
    viewport.dispatchEvent(new Event('touchstart'));
    for (const direction of [-1, 1]) {
      for (let step = 0; step < 8; step++) {
        viewport.scrollTop += direction * 0.25;
        if (notification === 'layout') document.dispatchEvent(new Event('visibilitychange'));
        viewport.dispatchEvent(new Event('scroll'));
      }
      expect(window.state.pinned).toBe(direction === 1);
    }
    viewport.dispatchEvent(new TouchEvent('touchend', { touches: [] }));
    await vi.advanceTimersByTimeAsync(200);
    expect(viewport.scrollTop).toBe(bottom);
    expect(window.state.pinned).toBe(true);
  }
);

test.each(['touchend', 'touchcancel'])(
  'a stopped %s still releases queued updates',
  async (type) => {
    const { window, viewport, content, keys } = fixture();
    await window.update(entries(100));
    await window.jumpTo('50', 'start');
    const row = content.querySelector('[data-timeline-key="50"]');
    if (!row) throw new Error('missing touched row');
    row.dispatchEvent(new Event('touchstart', { bubbles: true }));
    viewport.scrollTop += 20;
    viewport.dispatchEvent(new Event('scroll'));
    const offset = viewport.scrollTop;
    const top = row.getBoundingClientRect().top;
    const updated = entries(100).filter((entry) => entry.key !== '30');
    await window.update(updated);
    expect(keys()).toContain('30');
    row.addEventListener(type, (event) => {
      event.stopPropagation();
    });
    row.dispatchEvent(new TouchEvent(type, { bubbles: true, touches: [] }));
    await vi.advanceTimersByTimeAsync(200);
    expect(window.state.scrolling).toBe(false);
    expect(keys()).not.toContain('30');
    expect(row.getBoundingClientRect().top).toBe(top);
    expect(viewport.scrollTop).toBe(offset - 50);
  }
);

test.each([50, 300, 600])(
  'centering a message of height %s keeps its beginning visible',
  async (height) => {
    const { window, content } = fixture((value) => (value === 50 ? height : 50));
    await window.update(entries(100));
    expect(await window.jumpTo('50', 'center')).toBe(true);
    const row = content.querySelector('[data-timeline-key="50"]');
    if (!row) throw new Error('missing target row');
    expect(row.getBoundingClientRect().top).toBe(Math.max(0, (300 - height) / 2));
  }
);

test.each([
  { pinned: true, inRange: true },
  { pinned: true, inRange: false },
  { pinned: false, inRange: true },
  { pinned: false, inRange: false },
])(
  'a missing jump target preserves the reader (pinned: $pinned, in range: $inRange)',
  async ({ pinned, inRange }) => {
    const { window, viewport, content, keys, omitRow } = fixture();
    await window.update(entries(1000));
    if (!pinned) await window.jumpTo('500', 'start');
    const target = inRange ? (pinned ? '950' : '480') : '20';
    omitRow(target);
    const before = window.state;
    const previousKeys = keys();
    const offset = viewport.scrollTop;
    const anchorKey = pinned ? '995' : '500';
    const anchor = content.querySelector(`[data-timeline-key="${anchorKey}"]`);
    if (!anchor) throw new Error('missing reader anchor');
    const top = anchor.getBoundingClientRect().top;
    expect(await window.jumpTo(target)).toBe(false);
    expect(window.state).toEqual(before);
    expect(keys()).toEqual(previousKeys);
    expect(viewport.scrollTop).toBe(offset);
    expect(
      content.querySelector(`[data-timeline-key="${anchorKey}"]`)?.getBoundingClientRect().top
    ).toBe(top);
  }
);

test('a queued scroll re-pins after a resize clamps back to the previous offset', async () => {
  const { window, viewport, resizeViewport } = fixture();
  await window.update(entries(10));
  await window.jumpTo('0', 'start');
  expect(window.state.pinned).toBe(false);
  expect(viewport.scrollTop).toBe(0);
  viewport.scrollTop = 1;
  resizeViewport(600, false);
  expect(viewport.scrollTop).toBe(0);
  viewport.dispatchEvent(new Event('scroll'));
  expect(window.state.pinned).toBe(true);
});

test('a held touch keeps the latest rendered window bottom-aligned after its rows shrink', async () => {
  const { window, viewport, content, resize } = fixture();
  await window.update(entries(1_000));
  viewport.dispatchEvent(new Event('touchstart'));
  resize(25);
  expect(window.state.pinned).toBe(true);
  expect(content.lastElementChild?.getBoundingClientRect().bottom).toBe(
    viewport.getBoundingClientRect().bottom
  );
});

test('a keyboard viewport shrink keeps the latest row at the bottom during an active touch', async () => {
  const { window, viewport, content, resizeViewport } = fixture();
  await window.update(entries(1_000));
  viewport.dispatchEvent(new Event('touchstart'));
  resizeViewport(200);

  expect(window.state.pinned).toBe(true);
  expect(content.lastElementChild?.getBoundingClientRect().bottom).toBe(
    viewport.getBoundingClientRect().bottom
  );
});

test('backgrounding an interrupted touch settles queued updates without moving the reader', async () => {
  const { window, viewport, content } = fixture();
  await window.update(entries(100));
  await window.jumpTo('50', 'start');
  const anchor = content.querySelector<HTMLElement>('[data-timeline-key="50"]');
  if (!anchor) throw new Error('missing reader anchor');
  const top = anchor.getBoundingClientRect().top;

  viewport.dispatchEvent(new Event('touchstart'));
  const queued = entries(100);
  queued.splice(40, 0, { key: 'queued', value: 100 });
  await window.update(queued);
  expect(content.querySelector('[data-timeline-key="queued"]')).toBeNull();

  const visibility = vi.spyOn(document, 'visibilityState', 'get');
  try {
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(200);

    expect(content.querySelector('[data-timeline-key="queued"]')).not.toBeNull();
    expect(anchor.getBoundingClientRect().top).toBe(top);
    expect(window.state.scrolling).toBe(false);
  } finally {
    visibility.mockRestore();
  }
});

test('a subpixel native bottom still follows an appended message', async () => {
  const { window, viewport } = fixture();
  await window.update(entries(10));
  const bottom = viewport.scrollHeight - viewport.clientHeight;

  viewport.scrollTop = bottom - 100;
  viewport.dispatchEvent(new Event('scroll'));
  expect(window.state.pinned).toBe(false);

  viewport.scrollTop = bottom - 0.75;
  viewport.dispatchEvent(new Event('scroll'));
  expect(window.state.pinned).toBe(true);
  await window.update(entries(11));
  await vi.advanceTimersByTimeAsync(200);

  expect(window.state.pinned).toBe(true);
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
});

test('an external input restores a pinned timeline before its native scroll event', async () => {
  const { window, viewport } = fixture();
  await window.update(entries(10));
  const bottom = viewport.scrollHeight - viewport.clientHeight;
  const composer = document.createElement('textarea');
  document.body.append(composer);

  viewport.scrollTop = bottom - 6;
  composer.dispatchEvent(new Event('input', { bubbles: true }));
  viewport.dispatchEvent(new Event('scroll'));

  expect(window.state.pinned).toBe(true);
  expect(viewport.scrollTop).toBe(bottom);
});

test.each([
  { pinned: false, active: false },
  { pinned: true, active: true },
])(
  'an external input does not change an unpinned or active timeline',
  async ({ pinned, active }) => {
    const { window, viewport } = fixture();
    await window.update(entries(10));
    if (!pinned) {
      viewport.scrollTop -= 50;
      viewport.dispatchEvent(new Event('scroll'));
      await vi.advanceTimersByTimeAsync(200);
    }
    if (active) viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 20 }));
    const composer = document.createElement('textarea');
    document.body.append(composer);
    const offset = viewport.scrollTop;

    composer.dispatchEvent(new Event('input', { bubbles: true }));

    expect(window.state.pinned).toBe(pinned);
    expect(viewport.scrollTop).toBe(offset);
  }
);

test.each(['scroll', 'layout'])(
  'opening the keyboard preserves bottom following during %s',
  async (notification) => {
    const { window, viewport, resizeViewport } = fixture();
    await window.update(entries(10));
    viewport.dispatchEvent(new Event('pointerdown'));
    resizeViewport(200, false);
    viewport.scrollTop += 50;
    if (notification === 'layout') document.dispatchEvent(new Event('visibilitychange'));
    viewport.dispatchEvent(new Event('scroll'));
    expect(window.state.pinned).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
    expect(window.state.pinned).toBe(true);
  }
);

test.each([
  { pinned: true, delta: 50, notification: 'scroll' },
  { pinned: true, delta: -50, notification: 'scroll' },
  { pinned: false, delta: 50, notification: 'scroll' },
  { pinned: false, delta: -50, notification: 'scroll' },
  { pinned: true, delta: 50, notification: 'layout' },
  { pinned: true, delta: -50, notification: 'layout' },
  { pinned: false, delta: 50, notification: 'layout' },
  { pinned: false, delta: -50, notification: 'layout' },
])(
  'keyboard resizing respects touch direction (pinned: $pinned, delta: $delta, $notification)',
  async ({ pinned, delta, notification }) => {
    const { window, viewport, content, resizeViewport, render } = fixture();
    await window.update(entries(100));
    if (!pinned) await window.jumpTo('50', 'start');
    viewport.dispatchEvent(new Event('touchstart'));
    resizeViewport(200, false);
    viewport.scrollTop += delta;
    if (notification === 'layout') document.dispatchEvent(new Event('visibilitychange'));
    viewport.dispatchEvent(new Event('scroll'));
    const following = pinned && delta > 0;
    expect(window.state.pinned).toBe(following);
    const anchorKey = String(window.state.firstVisible);
    const anchor = content.querySelector(`[data-timeline-key="${anchorKey}"]`);
    if (!anchor) throw new Error('missing reader anchor');
    const top = anchor.getBoundingClientRect().top;
    const renders = render.mock.calls.length;
    await window.update(entries(101));
    await vi.advanceTimersByTimeAsync(200);
    expect(render).toHaveBeenCalledTimes(renders);
    viewport.dispatchEvent(new TouchEvent('touchend', { touches: [] }));
    await vi.advanceTimersByTimeAsync(200);
    expect(window.state.pinned).toBe(following);
    if (following) {
      expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
    } else {
      expect(
        content.querySelector(`[data-timeline-key="${anchorKey}"]`)?.getBoundingClientRect().top
      ).toBe(top);
    }
  }
);

test('touch interrupts a pending latest jump during keyboard resize and an incoming update', async () => {
  const { window, viewport, content, pause, resizeViewport } = fixture();
  await window.update(entries(1000));
  await window.jumpTo('20', 'start');
  const release = pause();
  const jump = window.jumpTo(null, 'start', true);
  viewport.dispatchEvent(new Event('touchstart'));
  viewport.scrollTop += 50;
  viewport.dispatchEvent(new Event('scroll'));
  resizeViewport(200);
  await window.update(entries(1001));
  release();
  expect(await jump).toBe(false);
  expect(window.state.pinned).toBe(false);
  const anchorKey = String(window.state.firstVisible);
  const anchor = content.querySelector(`[data-timeline-key="${anchorKey}"]`);
  if (!anchor) throw new Error('missing reader anchor');
  const top = anchor.getBoundingClientRect().top;
  viewport.dispatchEvent(new TouchEvent('touchend', { touches: [] }));
  await vi.advanceTimersByTimeAsync(200);
  expect(window.state.pinned).toBe(false);
  expect(
    content.querySelector(`[data-timeline-key="${anchorKey}"]`)?.getBoundingClientRect().top
  ).toBe(top);
});

test.each([0, 2])(
  'a room with %s messages stays at latest when it fills with the keyboard open',
  async (count) => {
    const { window, viewport, resizeViewport, content } = fixture();
    await window.update(entries(count));
    resizeViewport(200);
    await window.update(entries(1000));
    expect(window.state.pinned).toBe(true);
    expect(window.state.lastVisible).toBe(999);
    expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
    expect(content.children.length).toBeLessThanOrEqual(80);
    resizeViewport(300);
    expect(window.state.pinned).toBe(true);
    expect(viewport.scrollTop).toBe(viewport.scrollHeight - viewport.clientHeight);
  }
);

test.each(['update', 'resize'])(
  'content shrinking to fit restores bottom following after %s',
  async (change) => {
    const { window, viewport, content, resize } = fixture();
    await window.update(entries(10));
    await window.jumpTo('0', 'start');
    expect(window.state.pinned).toBe(false);
    if (change === 'update') await window.update(entries(2));
    else resize(10);
    expect(viewport.scrollHeight).toBe(viewport.clientHeight);
    expect(viewport.scrollTop).toBe(0);
    expect(window.state.pinned).toBe(true);
    expect(content.lastElementChild?.getBoundingClientRect().bottom).toBe(viewport.clientHeight);
  }
);

test.each(['missing', 'removed', 'unrendered'])(
  'a $0 jump target preserves the held gesture and queued update',
  async (target) => {
    const { window, viewport, render, omitRow } = fixture();
    await window.update(entries(100));
    viewport.dispatchEvent(new Event('touchstart'));
    const queued = target === 'removed' ? entries(99) : entries(101);
    if (target !== 'unrendered') await window.update(queued);
    else omitRow('99');
    const before = window.state;
    const offset = viewport.scrollTop;
    const renders = render.mock.calls.length;
    expect(await window.jumpTo(target === 'missing' ? 'missing' : '99')).toBe(false);
    expect(window.state).toEqual(before);
    expect(viewport.scrollTop).toBe(offset);
    await vi.advanceTimersByTimeAsync(200);
    expect(render).toHaveBeenCalledTimes(renders);
    viewport.dispatchEvent(new TouchEvent('touchend', { touches: [] }));
    await vi.advanceTimersByTimeAsync(200);
    expect(window.state.scrolling).toBe(false);
    if (target !== 'unrendered') expect(render.mock.calls.length).toBeGreaterThan(renders);
  }
);

test('a jump can target a message in a queued update', async () => {
  const { window, viewport } = fixture();
  await window.update(entries(100));
  viewport.dispatchEvent(new Event('touchstart'));
  await window.update(entries(101));
  expect(await window.jumpTo('100')).toBe(true);
  expect(window.state.lastVisible).toBe(100);
});

test.each([false, true])(
  'a seek during an incoming render fills the destination (touch held: %s)',
  async (touching) => {
    const { window, viewport, pause } = fixture();
    await window.update(entries(1000));
    const release = pause();
    const update = window.update(entries(1001));
    if (touching) viewport.dispatchEvent(new Event('touchstart'));
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event('scroll'));
    release();
    await update;
    await vi.advanceTimersByTimeAsync(0);
    expect(window.state.firstVisible).toBe(0);
  }
);

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

const gapCases: {
  name: string;
  count: number;
  change: (f: Fixture) => void | Promise<void>;
}[] = [
  {
    name: 'rows shrink',
    count: 1_000,
    change: (f) => {
      f.resize(25);
    },
  },
  {
    name: 'rows grow',
    count: 1_000,
    change: (f) => {
      f.resize(90);
    },
  },
  {
    name: 'the viewport shrinks',
    count: 1_000,
    change: (f) => {
      f.resizeViewport(200);
    },
  },
  {
    name: 'the viewport grows',
    count: 1_000,
    change: (f) => {
      f.resizeViewport(600);
    },
  },
  {
    name: 'a short room shrinks its rows',
    count: 4,
    change: (f) => {
      f.resize(25);
    },
  },
  {
    name: 'a short room grows past the viewport',
    count: 4,
    change: (f) => {
      f.resize(90);
    },
  },
  { name: 'a message is appended', count: 1_000, change: (f) => f.window.update(entries(1_001)) },
];

test.each(gapCases)(
  'an idle pinned timeline leaves no gap under the latest row when $name',
  async ({ count, change }) => {
    const f = fixture();
    await f.window.update(entries(count));
    expect(f.window.state.pinned).toBe(true);

    await change(f);
    await vi.advanceTimersByTimeAsync(200);

    expect(f.window.state.pinned).toBe(true);
    expect(f.viewport.scrollHeight - f.viewport.clientHeight - f.viewport.scrollTop).toBe(0);
    expect(f.content.lastElementChild?.getBoundingClientRect().bottom).toBe(
      f.viewport.getBoundingClientRect().bottom
    );
  }
);

test('a send that resizes the composer before its scroll event keeps following latest', async () => {
  const f = fixture();
  await f.window.update(entries(1_000));
  expect(f.window.state.pinned).toBe(true);

  f.resizeViewport(360, false);
  f.resizeViewport(320, false);
  f.viewport.dispatchEvent(new Event('scroll'));

  expect(f.window.state.pinned).toBe(true);

  await f.window.update(entries(1_001));
  await vi.advanceTimersByTimeAsync(200);

  expect(f.window.state.pinned).toBe(true);
  expect(f.content.lastElementChild?.getBoundingClientRect().bottom).toBe(
    f.viewport.getBoundingClientRect().bottom
  );
});

test('opening on an unread marker in a room that fits leaves no gap under the last row', async () => {
  const f = fixture();
  await f.window.update(entries(4));

  await f.window.jumpTo('1', 'start');

  expect(f.content.lastElementChild?.getBoundingClientRect().bottom).toBe(
    f.viewport.getBoundingClientRect().bottom
  );
});

test('a room opened on its last unread stays flush when the marker row is removed', async () => {
  const f = fixture();
  await f.window.update(entries(1_000));
  await f.window.jumpTo('998', 'start');
  await vi.advanceTimersByTimeAsync(200);
  expect(f.window.state.pinned).toBe(true);

  await f.window.update(entries(1_000).filter((entry) => entry.key !== '998'));
  await vi.advanceTimersByTimeAsync(200);

  expect(f.content.lastElementChild?.getBoundingClientRect().bottom).toBe(
    f.viewport.getBoundingClientRect().bottom
  );
});
