// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import Slider from './Slider.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('a key press steps the value and commits it', async () => {
  const oninput = vi.fn();
  const oncommit = vi.fn();
  const instance = mount(Slider, {
    target: document.body,
    props: { min: 0, max: 1, step: 0.25, label: 'Volume', value: 0.5, oninput, oncommit },
  });
  await tick();

  const thumb = document.querySelector<HTMLElement>('[role="slider"]');
  expect(thumb?.getAttribute('aria-label')).toBe('Volume');
  thumb?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await tick();

  expect(oninput).toHaveBeenLastCalledWith(0.75);
  expect(oncommit).toHaveBeenLastCalledWith(0.75);

  await unmount(instance);
});

test('a touch on the track does not change the value', async () => {
  const oninput = vi.fn();
  const oncommit = vi.fn();
  const instance = mount(Slider, {
    target: document.body,
    props: {
      min: 0,
      max: 1,
      step: 0.25,
      label: 'Display scale',
      value: 0.5,
      requireThumbForTouch: true,
      oninput,
      oncommit,
    },
  });
  await tick();

  const track = document.querySelector<HTMLElement>('.slider-track');
  track?.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 100,
      pointerType: 'touch',
    })
  );
  document.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'touch' })
  );
  await tick();

  expect(oninput).not.toHaveBeenCalled();
  expect(oncommit).not.toHaveBeenCalled();

  await unmount(instance);
});

test('a touch that starts on the thumb can change the value', async () => {
  const oninput = vi.fn();
  const oncommit = vi.fn();
  const instance = mount(Slider, {
    target: document.body,
    props: {
      min: 0,
      max: 1,
      step: 0.25,
      label: 'Display scale',
      value: 0.5,
      requireThumbForTouch: true,
      oninput,
      oncommit,
    },
  });
  await tick();

  const slider = document.querySelector<HTMLElement>('.slider');
  if (!slider) throw new Error('Missing slider');
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 100 } as DOMRect);
  const thumb = document.querySelector<HTMLElement>('[role="slider"]');
  thumb?.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 50, pointerType: 'touch' })
  );
  oninput.mockClear();
  document.dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, button: 0, clientX: 75, pointerType: 'touch' })
  );
  document.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'touch' })
  );
  await tick();

  expect(oninput).toHaveBeenLastCalledWith(0.75);
  expect(oncommit).toHaveBeenLastCalledWith(0.75);

  await unmount(instance);
});
