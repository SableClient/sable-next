import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import fixture from './verification-qr.fixture.json' with { type: 'json' };

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

import { core } from '#lib/core/__mocks__/context.js';

import DeviceVerificationDialog from './DeviceVerificationDialog.svelte';

afterEach(async () => {
  await page.viewport(414, 800);
});

test('the verification dialog shows a square code to scan on desktop and on a phone', async () => {
  Object.assign(core, {
    session: { user_id: '@e2e:example.test' },
    verification: {
      userId: '@e2e:example.test',
      flowId: 'e2e-flow',
      state: { phase: 'choose', qr: fixture.code, can_scan: true, can_compare: true },
    },
  });
  core.commands = core;
  await page.viewport(1280, 800);
  const screen = await render(DeviceVerificationDialog);
  const code = screen
    .getByRole('dialog', { name: 'Device verification' })
    .getByRole('img', { name: 'Verification code' });
  await expect.element(code).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Compare emoji instead' })).toBeVisible();

  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ] as const) {
    await page.viewport(width, height);
    await expect
      .poll(() => code.element().getBoundingClientRect().width, { timeout: 3_000 })
      .toBeGreaterThan(200);
    const box = code.element().getBoundingClientRect();
    expect(Math.abs(box.width - box.height)).toBeLessThan(1);
  }
});
