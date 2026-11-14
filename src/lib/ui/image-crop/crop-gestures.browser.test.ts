import { expect, test, vi } from 'vitest';

import { render } from 'vitest-browser-svelte';

import CropGesturesHarness from './CropGesturesHarness.test.svelte';
import type { GestureTarget } from './crop-gestures';

async function setup(enabled = true) {
  const target = {
    enabled: () => enabled,
    pan: vi.fn(),
    zoom: vi.fn(),
    startResize: vi.fn(),
    resize: vi.fn(),
    active: vi.fn(),
  } satisfies GestureTarget;
  const screen = await render(CropGesturesHarness, { gestures: target });
  const stage = screen.container.querySelector<HTMLElement>('.stage');
  const handle = screen.container.querySelector<HTMLElement>('.handle');
  if (!stage || !handle) throw new Error('No stage');
  stage.setPointerCapture = () => {};
  return { stage, handle, target, detach: () => screen.unmount() };
}

function pointer(on: Element, type: string, pointerId: number, clientX: number, clientY: number) {
  on.dispatchEvent(
    new PointerEvent(type, { pointerId, clientX, clientY, button: 0, bubbles: true })
  );
}

test('one pointer pans by its movement', async () => {
  const { stage, target, detach } = await setup();
  pointer(stage, 'pointerdown', 1, 200, 150);
  pointer(stage, 'pointermove', 1, 230, 140);
  pointer(stage, 'pointerup', 1, 230, 140);

  expect(target.pan).toHaveBeenCalledWith(30, -10);
  expect(target.active.mock.calls).toEqual([[true], [false]]);
  await detach();
});

test('two pointers pinch around their midpoint', async () => {
  const { stage, target, detach } = await setup();
  pointer(stage, 'pointerdown', 1, 200, 150);
  pointer(stage, 'pointerdown', 2, 300, 150);
  pointer(stage, 'pointermove', 2, 400, 150);

  expect(target.zoom).toHaveBeenCalledWith(2, { x: 200, y: 100 });
  expect(target.pan).toHaveBeenCalledWith(50, 0);
  await detach();
});

test('a corner drag resizes by the movement since it started', async () => {
  const { handle, stage, target, detach } = await setup();
  pointer(handle, 'pointerdown', 1, 200, 150);
  pointer(stage, 'pointermove', 1, 210, 160);
  pointer(stage, 'pointermove', 1, 220, 155);

  expect(target.startResize).toHaveBeenCalledWith('se');
  expect(target.resize).toHaveBeenLastCalledWith(20, 5);
  expect(target.pan).not.toHaveBeenCalled();
  await detach();
});

test('the wheel zooms at the pointer, and nothing runs while disabled', async () => {
  const { stage, target, detach } = await setup();
  stage.dispatchEvent(
    new WheelEvent('wheel', { deltaY: -100, clientX: 150, clientY: 80, cancelable: true })
  );
  expect(target.zoom).toHaveBeenCalledWith(Math.exp(0.15), { x: 50, y: 30 });
  await detach();

  const idle = await setup(false);
  pointer(idle.stage, 'pointerdown', 1, 200, 150);
  pointer(idle.stage, 'pointermove', 1, 230, 140);
  idle.stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
  expect(idle.target.pan).not.toHaveBeenCalled();
  expect(idle.target.zoom).not.toHaveBeenCalled();
  await idle.detach();
});
