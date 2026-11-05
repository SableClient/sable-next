import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import {
  applyDeploymentLocks,
  preferences,
  setPreference,
} from '#lib/settings/preferences.svelte.js';
import CallServiceSettings from './CallServiceSettings.svelte';
import SettingsCategorySections from '#lib/features/settings/SettingsCategorySections.svelte';
import { callsCategory } from '#lib/settings/registry/calls.js';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

afterEach(() => {
  applyDeploymentLocks({});
  setPreference('callServiceUrl', '');
  localStorage.removeItem('sable-preferences');
});

test.each([390, 1280])('saves and resets the fallback at %spx', async (width) => {
  await page.viewport(width, 844);
  const screen = await render(SettingsCategorySections, {
    category: {
      ...callsCategory,
      sections: callsCategory.sections.filter((section) => section.id === 'call-service'),
      items: [],
    },
  });
  expect(
    screen.getByRole('heading', { name: 'Call service', exact: true }).elements()
  ).toHaveLength(1);
  const input = screen.getByRole('textbox', { name: 'MatrixRTC fallback URL' });
  const apply = screen.getByRole('button', { name: 'Apply', exact: true });
  const reset = screen.getByRole('button', { name: 'Reset', exact: true });
  await expect.element(apply).toBeDisabled();
  await userEvent.fill(input, 'https://rtc.example.org/livekit/jwt');
  expect(preferences.callServiceUrl).toBe('');
  await userEvent.click(apply);
  await expect.poll(() => preferences.callServiceUrl).toBe('https://rtc.example.org/livekit/jwt');
  const stored = JSON.parse(localStorage.getItem('sable-preferences') ?? '{}') as {
    callServiceUrl?: string;
  };
  expect(stored.callServiceUrl).toBe('https://rtc.example.org/livekit/jwt');
  await expect.element(apply).toBeDisabled();
  await userEvent.click(reset);
  await expect.poll(() => preferences.callServiceUrl).toBe('');
  await expect.element(input).toHaveValue('');
});

test('rejects unsafe URLs without changing the saved fallback', async () => {
  setPreference('callServiceUrl', 'https://saved.example.org/');
  const screen = await render(CallServiceSettings);
  const input = screen.getByRole('textbox', { name: 'MatrixRTC fallback URL' });
  await userEvent.fill(input, 'https://user:password@rtc.example.org');
  await expect.element(input).toHaveAttribute('aria-invalid', 'true');
  await expect.element(screen.getByRole('status')).toBeVisible();
  await expect.element(screen.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled();
  expect(preferences.callServiceUrl).toBe('https://saved.example.org/');
});

test('follows a changed saved value and respects deployment locks', async () => {
  const screen = await render(CallServiceSettings);
  const input = screen.getByRole('textbox', { name: 'MatrixRTC fallback URL' });
  setPreference('callServiceUrl', 'https://changed.example.org/');
  await expect.element(input).toHaveValue('https://changed.example.org/');
  applyDeploymentLocks({ callServiceUrl: 'https://locked.example.org/' });
  await expect.element(input).toHaveValue('https://locked.example.org/');
  await expect.element(input).toBeDisabled();
  await expect.element(screen.getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
});
