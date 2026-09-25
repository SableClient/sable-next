// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import { nativeVideoSlot } from './native-video-overlay';

afterEach(() => {
  vi.restoreAllMocks();
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
