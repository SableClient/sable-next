// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import { nativeVideoSlot } from './native-video-overlay';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function slotAt(rect: { x: number; y: number; width: number; height: number }): HTMLElement {
  const slot = document.createElement('div');
  document.body.append(slot);
  vi.spyOn(slot, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(rect.x, rect.y, rect.width, rect.height)
  );
  return slot;
}

const overlay = () => ({
  place: vi.fn(() => Promise.resolve()),
  clear: vi.fn(() => Promise.resolve()),
});

test('places the native view over the slot and clears it on teardown', () => {
  const slot = slotAt({ x: 10, y: 20, width: 160, height: 90 });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(slot);
  const native = overlay();

  const detach = nativeVideoSlot(native)(slot);
  expect(native.place).toHaveBeenCalledWith(
    expect.objectContaining({ x: 10, y: 20, width: 160, height: 90 })
  );

  detach();
  expect(native.clear).toHaveBeenCalled();
});

test('does not place the view over a slot something else covers', () => {
  const slot = slotAt({ x: 10, y: 20, width: 160, height: 90 });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(document.body);
  const native = overlay();

  const detach = nativeVideoSlot(native)(slot);
  expect(native.place).not.toHaveBeenCalled();

  detach();
});

test('does not place the view over an empty slot', () => {
  const slot = slotAt({ x: 0, y: 0, width: 0, height: 0 });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(slot);
  const native = overlay();

  const detach = nativeVideoSlot(native)(slot);
  expect(native.place).not.toHaveBeenCalled();

  detach();
});

function queueFrames(): { run: () => void; cancel: ReturnType<typeof vi.fn> } {
  let queued: FrameRequestCallback[] = [];
  const cancel = vi.fn((id: number) => {
    queued[id - 1] = () => {};
  });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => queued.push(callback))
  );
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return {
    run: () => {
      const due = queued;
      queued = [];
      for (const callback of due) callback(0);
    },
    cancel,
  };
}

test('measures once per frame however many changes arrive in it', async () => {
  const frames = queueFrames();
  const slot = slotAt({ x: 10, y: 20, width: 160, height: 90 });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(slot);
  const native = overlay();
  const measure = vi.spyOn(slot, 'getBoundingClientRect');
  const detach = nativeVideoSlot(native)(slot);
  measure.mockClear();

  document.body.append(document.createElement('span'));
  document.body.className = 'moved';
  window.dispatchEvent(new Event('resize'));
  document.dispatchEvent(new Event('scroll'));
  await Promise.resolve();
  expect(measure).not.toHaveBeenCalled();
  expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

  measure.mockReturnValue(new DOMRect(30, 40, 160, 90));
  frames.run();
  expect(measure).toHaveBeenCalledTimes(1);
  expect(native.place).toHaveBeenLastCalledWith(expect.objectContaining({ x: 30, y: 40 }));

  detach();
});

test('a teardown cancels the frame it had pending', () => {
  const frames = queueFrames();
  const slot = slotAt({ x: 10, y: 20, width: 160, height: 90 });
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(slot);
  const native = overlay();
  const detach = nativeVideoSlot(native)(slot);

  window.dispatchEvent(new Event('resize'));
  detach();
  frames.run();

  expect(frames.cancel).toHaveBeenCalledWith(1);
  expect(native.place).toHaveBeenCalledTimes(1);
});
