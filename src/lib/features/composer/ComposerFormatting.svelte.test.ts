// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

import ComposerFormatting from './ComposerFormatting.svelte';

function renderBar() {
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
  return { onFormat };
}

test('every format is offered without expanding the bar', async () => {
  const { onFormat } = renderBar();

  await fireEvent.click(screen.getByRole('button', { name: 'composer.table' }));

  expect(onFormat).toHaveBeenCalledWith('table');
  expect(screen.getByRole('button', { name: 'composer.textColor' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'composer.markdownSource' })).toBeInTheDocument();
});

test('a formatting button names itself on hover', async () => {
  renderBar();

  await fireEvent.pointerMove(screen.getByRole('button', { name: 'composer.bold' }), {
    pointerType: 'mouse',
  });

  expect(
    await screen.findByText('composer.bold (Ctrl+B)', { selector: '.tooltip' })
  ).toBeInTheDocument();
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
