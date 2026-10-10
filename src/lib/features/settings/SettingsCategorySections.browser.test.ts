import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { settingsCategories } from '#lib/settings/registry.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import SettingsCategorySections from './SettingsCategorySections.svelte';

afterEach(() => {
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
