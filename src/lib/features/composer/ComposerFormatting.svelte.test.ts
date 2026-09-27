// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

import ComposerFormatting from './ComposerFormatting.svelte';

function renderBar(overflowing: boolean): HTMLElement {
  render(
    ComposerFormatting,
    {
      active: [],
      source: false,
      markdown: false,
      colors: { fg: null, bg: null },
      onFormat: vi.fn(),
      onColor: vi.fn(),
      onToggleSource: vi.fn(),
    },
    { wrapper: TooltipProvider }
  );
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

test('a formatting button names itself on hover', async () => {
  renderBar(true);

  await fireEvent.pointerMove(screen.getByRole('button', { name: 'composer.bold' }), {
    pointerType: 'mouse',
  });

  expect(await screen.findByText('composer.bold', { selector: '.tooltip' })).toBeInTheDocument();
});

test('a formatting button still formats with its tooltip attached', async () => {
  const onFormat = vi.fn();
  render(
    ComposerFormatting,
    {
      active: [],
      source: false,
      markdown: false,
      colors: { fg: null, bg: null },
      onFormat,
      onColor: vi.fn(),
      onToggleSource: vi.fn(),
    },
    { wrapper: TooltipProvider }
  );

  await fireEvent.click(screen.getByRole('button', { name: 'composer.italic' }));

  expect(onFormat).toHaveBeenCalledWith('em');
});
