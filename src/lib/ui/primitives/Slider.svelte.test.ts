// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import Slider from './Slider.svelte';

test('a key press steps the value and commits it', async () => {
  const user = userEvent.setup();
  const oninput = vi.fn();
  const oncommit = vi.fn();
  render(Slider, { min: 0, max: 1, step: 0.25, label: 'Volume', value: 0.5, oninput, oncommit });

  screen.getByRole('slider', { name: 'Volume' }).focus();
  await user.keyboard('{ArrowRight}');

  expect(oninput).toHaveBeenLastCalledWith(0.75);
  expect(oncommit).toHaveBeenLastCalledWith(0.75);
});

function renderTouchSlider() {
  const oninput = vi.fn();
  const oncommit = vi.fn();
  const { container } = render(Slider, {
    min: 0,
    max: 1,
    step: 0.25,
    label: 'Display scale',
    value: 0.5,
    requireThumbForTouch: true,
    oninput,
    oncommit,
  });
  return { user: userEvent.setup(), container, oninput, oncommit };
}

test('a touch on the track does not change the value', async () => {
  const { user, container, oninput, oncommit } = renderTouchSlider();

  const track = container.querySelector<HTMLElement>('.slider-track');
  if (!track) throw new Error('Missing track');
  await user.pointer([
    { keys: '[TouchA>]', target: track, coords: { clientX: 100 } },
    { keys: '[/TouchA]', target: track },
  ]);

  expect(oninput).not.toHaveBeenCalled();
  expect(oncommit).not.toHaveBeenCalled();
});

test('a touch that starts on the thumb can change the value', async () => {
  const { user, container, oninput, oncommit } = renderTouchSlider();

  const slider = container.querySelector<HTMLElement>('.slider');
  if (!slider) throw new Error('Missing slider');
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 100 } as DOMRect);
  const thumb = screen.getByRole('slider', { name: 'Display scale' });
  await user.pointer({ keys: '[TouchA>]', target: thumb, coords: { clientX: 50 } });
  oninput.mockClear();
  await user.pointer([
    { pointerName: 'TouchA', target: thumb, coords: { clientX: 75 } },
    { keys: '[/TouchA]', target: thumb },
  ]);

  expect(oninput).toHaveBeenLastCalledWith(0.75);
  expect(oncommit).toHaveBeenLastCalledWith(0.75);
});
