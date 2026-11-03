import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { VerificationView } from '#src/generated/protocol';

import fixture from './verification-qr.fixture.json' with { type: 'json' };

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({ holdOverlayBack: () => {} }));

import { core } from '#lib/core/__mocks__/context.js';
import { expectNoA11yViolations } from '#lib/test-support/a11y.js';

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

const emojis = ['Dog', 'Cat', 'Lion', 'Horse', 'Unicorn', 'Pig', 'Elephant'].map((description) => ({
  symbol: 'x',
  description,
}));

const phases: VerificationView[] = [
  { phase: 'requested', is_self: true, initiated_by_us: false },
  { phase: 'requested', is_self: true, initiated_by_us: true },
  { phase: 'waiting' },
  { phase: 'choose', qr: fixture.code, can_scan: true, can_compare: true },
  { phase: 'choose', qr: null, can_scan: false, can_compare: true },
  { phase: 'scanned' },
  { phase: 'reciprocated' },
  { phase: 'compare', emojis, decimals: [1234, 5678, 9012] },
  { phase: 'confirmed' },
  { phase: 'done' },
  { phase: 'cancelled', reason: 'The other device cancelled' },
];

test('every verification phase has no accessibility violations', async () => {
  core.commands = core;
  await page.viewport(1280, 800);
  for (const state of phases) {
    Object.assign(core, {
      session: { user_id: '@e2e:example.test' },
      verification: { userId: '@e2e:example.test', flowId: 'e2e-flow', state },
    });
    const screen = await render(DeviceVerificationDialog);
    await expect.element(screen.getByRole('dialog', { name: 'Device verification' })).toBeVisible();
    await expectNoA11yViolations(document.body);
    await screen.unmount();
  }
});
