// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import ComposerFormatting from './ComposerFormatting.svelte';

function renderBar(overflowing: boolean): HTMLElement {
  render(ComposerFormatting, {
    active: [],
    source: false,
    markdown: false,
    colors: { fg: null, bg: null },
    onFormat: vi.fn(),
    onColor: vi.fn(),
    onToggleSource: vi.fn(),
  });
  const bar = screen.getByRole('group', { name: 'composer.formatting' });
  Object.defineProperty(bar, 'clientWidth', { value: 200 });
  Object.defineProperty(bar, 'scrollWidth', { value: overflowing ? 800 : 200 });
  return bar;
}

test('a vertical wheel scrolls an overflowing toolbar sideways', async () => {
  const bar = renderBar(true);

  const handled = await fireEvent.wheel(bar, { deltaY: 120 });

  expect(handled).toBe(false);
  expect(bar.scrollLeft).toBe(120);
});

test('the wheel is left alone when the toolbar fits', async () => {
  const bar = renderBar(false);

  const handled = await fireEvent.wheel(bar, { deltaY: 120 });

  expect(handled).toBe(true);
  expect(bar.scrollLeft).toBe(0);
});
