import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  holdOverlayBack: () => {},
  afterOverlayPops: () => Promise.resolve(),
}));

import { expectNoA11yViolations } from '#lib/test-support/a11y.js';

import ShortcutsHelpDialog from './ShortcutsHelpDialog.svelte';

test('the shortcuts dialog has no accessibility violations', async () => {
  await page.viewport(1280, 800);
  const screen = await render(ShortcutsHelpDialog, { open: true });
  await expect.element(screen.getByRole('dialog')).toBeVisible();
  await expectNoA11yViolations(document.body);
});
