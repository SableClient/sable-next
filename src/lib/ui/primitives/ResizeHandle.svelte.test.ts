// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import ResizeHandle from './ResizeHandle.svelte';

function handle(): HTMLElement {
  const slider = screen.getByRole('slider', { name: 'Resize' });
  slider.setPointerCapture = vi.fn();
  return slider;
}

test('a drag grows the value toward the side the handle grows', async () => {
  const user = userEvent.setup();
  const onResize = vi.fn();
  const onCommit = vi.fn();
  render(ResizeHandle, {
    value: 100,
    min: 0,
    max: 500,
    label: 'Resize',
    grow: 'left',
    step: 10,
    onResize,
    onCommit,
  });
  const target = handle();

  await user.pointer([
    { keys: '[MouseLeft>]', target, coords: { clientX: 300 } },
    { target, coords: { clientX: 260 } },
  ]);
  expect(onResize).toHaveBeenLastCalledWith(140);
  expect(onCommit).not.toHaveBeenCalled();
  await user.pointer({ keys: '[/MouseLeft]', target, coords: { clientX: 260 } });
  expect(onCommit).toHaveBeenCalledOnce();
});

test('a secondary button does not start a drag', async () => {
  const user = userEvent.setup();
  const onResize = vi.fn();
  render(ResizeHandle, {
    value: 100,
    min: 0,
    max: 500,
    label: 'Resize',
    grow: 'right',
    step: 10,
    onResize,
  });
  const target = handle();

  await user.pointer([
    { keys: '[MouseRight>]', target, coords: { clientX: 300 } },
    { target, coords: { clientX: 340 } },
  ]);
  expect(onResize).not.toHaveBeenCalled();
});

test('arrow keys step with the grow direction and Home and End are opt-in', async () => {
  const user = userEvent.setup();
  const onResize = vi.fn();
  render(ResizeHandle, {
    value: 100,
    min: 20,
    max: 500,
    label: 'Resize',
    grow: 'right',
    step: 10,
    shiftStep: 40,
    onResize,
  });
  handle().focus();

  await user.keyboard('{ArrowLeft}');
  expect(onResize).toHaveBeenLastCalledWith(90);
  await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
  expect(onResize).toHaveBeenLastCalledWith(140);
  await user.keyboard('{Home}');
  expect(onResize).toHaveBeenCalledTimes(2);
});
