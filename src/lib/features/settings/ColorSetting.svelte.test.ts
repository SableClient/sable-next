// @vitest-environment happy-dom

import { mount, tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import ColorSetting from './ColorSetting.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('opens the picker from its swatch', async () => {
  mount(ColorSetting, {
    target: document.body,
    props: {
      label: 'Profile color',
      value: '',
      onSave: vi.fn(),
      onReset: vi.fn(),
    },
  });

  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Choose Profile color"]');
  expect(trigger?.tagName).toBe('BUTTON');
  trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
  await tick();

  expect(trigger?.getAttribute('aria-expanded')).toBe('true');
});
