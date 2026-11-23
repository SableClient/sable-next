import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import { setCurrentLanguage } from '#lib/language.svelte.js';
import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

import ComposerFormatting from './ComposerFormatting.svelte';

afterEach(async () => {
  document.documentElement.dir = 'ltr';
  setCurrentLanguage('en', 'ltr');
  await page.viewport(414, 896);
});

test.each([
  ['ltr', 1],
  ['rtl', -1],
] as const)('the mouse wheel scrolls the %s formatting bar toward its end', async (dir, sign) => {
  document.documentElement.dir = dir;
  setCurrentLanguage(dir === 'rtl' ? 'ar' : 'en', dir);
  await page.viewport(320, 600);
  const screen = await render(
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
  const bar = screen.container.querySelector<HTMLElement>('.formatting');
  if (!bar) throw new Error('.formatting is not rendered');
  expect(bar.scrollWidth).toBeGreaterThan(bar.clientWidth);

  bar.dispatchEvent(new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true }));

  await expect.poll(() => sign * bar.scrollLeft).toBeGreaterThan(0);
});
