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
