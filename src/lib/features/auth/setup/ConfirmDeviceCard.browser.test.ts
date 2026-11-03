import { expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  holdOverlayBack: () => {},
  afterOverlayPops: () => Promise.resolve(),
}));

import { core } from '#lib/core/__mocks__/context.js';
import { expectNoA11yViolations } from '#lib/test-support/a11y.js';

import ConfirmDeviceCard from './ConfirmDeviceCard.svelte';

test('every view of the confirm device card has no accessibility violations', async () => {
  Object.assign(core, {
    session: { user_id: '@me:example.org', device_id: 'THIS' },
    encryption: {
      verification: 'unverified',
      recovery: 'enabled',
      cross_signing_ready: false,
      backup_unlocked: false,
      signing_keys: { master: false, self_signing: false, user_signing: false },
      recovery_passphrase: false,
      account_data_key: false,
    },
    deviceList: [],
  });
  await page.viewport(1280, 800);
  const screen = await render(ConfirmDeviceCard, {
    onComplete: vi.fn(),
    onSkip: vi.fn(),
    onReset: vi.fn(),
  });
  const choose = screen.getByRole('button', { name: /Use recovery key/ });
  await expect.element(choose).toBeVisible();
  await expectNoA11yViolations(screen.container);

  await userEvent.click(choose);
  await expect.element(screen.getByRole('button', { name: 'Back' })).toBeVisible();
  await expectNoA11yViolations(screen.container);

  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  await userEvent.click(screen.getByRole('button', { name: /Can.t confirm/ }));
  await expect.element(screen.getByRole('button', { name: 'Back' })).toBeVisible();
  await expectNoA11yViolations(screen.container);
});
