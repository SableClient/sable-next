import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/platform/overlay-back.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/overlay-back.svelte.js')>()),
  holdOverlayBack: () => {},
}));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { settingsCategories } from '#lib/settings/registry.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import SettingsCategorySections from './SettingsCategorySections.svelte';

afterEach(async () => {
  await page.viewport(414, 800);
  setPreference('textScale', 1);
  localStorage.removeItem('sable-preferences');
});

function storedTextScale(): number | undefined {
  const stored = JSON.parse(localStorage.getItem('sable-preferences') ?? '{}') as {
    textScale?: number;
  };
  return stored.textScale;
}

test('a size setting takes a typed percentage and clamps it', async () => {
  const category = settingsCategories.find((entry) => entry.id === 'appearance');
  if (!category) throw new Error('the appearance category is missing');
  const screen = await render(SettingsCategorySections, { category });
  const field = screen.getByRole('spinbutton', { name: 'Text size in percent' });

  await userEvent.fill(field.element(), '120');
  await userEvent.keyboard('{Enter}');
  await expect.poll(storedTextScale).toBe(1.2);

  await userEvent.fill(field.element(), '900');
  await userEvent.keyboard('{Enter}');
  await expect.element(field).toHaveValue(150);
  await expect.poll(storedTextScale).toBe(1.5);
});

test('the media preview setting is offered in privacy settings', async () => {
  const category = settingsCategories.find((entry) => entry.id === 'privacy');
  if (!category) throw new Error('the privacy category is missing');
  const screen = await render(SettingsCategorySections, { category });

  await expect.element(screen.getByRole('switch', { name: 'Avatars on invites' })).toBeChecked();
});

test('mobile: a dropdown opens as a sheet of choices', async () => {
  await page.viewport(412, 915);
  const category = settingsCategories.find((entry) => entry.id === 'appearance');
  if (!category) throw new Error('the appearance category is missing');
  const screen = await render(SettingsCategorySections, { category });

  await userEvent.click(screen.getByRole('button', { name: 'Room icons' }));
  const sheet = screen.getByRole('dialog', { name: 'Room icons' });
  await userEvent.click(sheet.getByRole('radio', { name: 'Never' }));

  await expect.poll(() => screen.getByRole('dialog').elements().length).toBe(0);
  await expect
    .poll(() => screen.getByRole('button', { name: 'Room icons' }).element().textContent)
    .toContain('Never');
});
