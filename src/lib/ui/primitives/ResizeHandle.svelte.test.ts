// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import ResizeHandle from './ResizeHandle.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

function queryHandle(): HTMLButtonElement {
  const handle = document.querySelector<HTMLButtonElement>('.resize-handle');
  if (!handle) throw new Error('no resize handle');
  handle.setPointerCapture = vi.fn();
  return handle;
}

function pointer(type: string, clientX: number, button = 0): PointerEvent {
  return new PointerEvent(type, { pointerId: 1, clientX, button, bubbles: true });
}

test('a drag grows the value toward the side the handle grows', async () => {
  const onResize = vi.fn();
  const onCommit = vi.fn();
  const instance = mount(ResizeHandle, {
    target: document.body,
    props: {
      value: 100,
      min: 0,
      max: 500,
      label: 'Resize',
      grow: 'left',
      step: 10,
      onResize,
      onCommit,
    },
  });
  await tick();

  const handle = queryHandle();
  handle.dispatchEvent(pointer('pointerdown', 300));
  handle.dispatchEvent(pointer('pointermove', 260));
  expect(onResize).toHaveBeenLastCalledWith(140);
  expect(onCommit).not.toHaveBeenCalled();
  handle.dispatchEvent(pointer('pointerup', 260));
  expect(onCommit).toHaveBeenCalledOnce();

  await unmount(instance);
});

test('a secondary button does not start a drag', async () => {
  const onResize = vi.fn();
  const instance = mount(ResizeHandle, {
    target: document.body,
    props: { value: 100, min: 0, max: 500, label: 'Resize', grow: 'right', step: 10, onResize },
  });
  await tick();

  const handle = queryHandle();
  handle.dispatchEvent(pointer('pointerdown', 300, 2));
  handle.dispatchEvent(pointer('pointermove', 340));
  expect(onResize).not.toHaveBeenCalled();

  await unmount(instance);
});

test('arrow keys step with the grow direction and Home and End are opt-in', async () => {
  const onResize = vi.fn();
  const instance = mount(ResizeHandle, {
    target: document.body,
    props: {
      value: 100,
      min: 20,
      max: 500,
      label: 'Resize',
      grow: 'right',
      step: 10,
      shiftStep: 40,
      onResize,
    },
  });
  await tick();

  const handle = queryHandle();
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  expect(onResize).toHaveBeenLastCalledWith(90);
  handle.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true })
  );
  expect(onResize).toHaveBeenLastCalledWith(140);
  handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  expect(onResize).toHaveBeenCalledTimes(2);

  await unmount(instance);
});
