// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { applyPreferences, preferences } from '#lib/settings/preferences.svelte.js';

import SettingsFile from './SettingsFile.svelte';

const initial = { ...preferences };
const gateway = 'https://push.example.org/_matrix/push/v1/notify';

afterEach(() => {
  applyPreferences(initial);
});

async function choose(text: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing file input');
  await userEvent.upload(input, new File([text], 'settings.json', { type: 'application/json' }));
}

test('applies a settings file only after confirmation that names the gateway', async () => {
  const user = userEvent.setup();
  applyPreferences({ ...initial, dateFormat: 'dmy', developerTools: false });
  render(SettingsFile);
  await choose(
    JSON.stringify({
      'moe.sable.next.settings': {
        v: 1,
        settings: {
          dateFormat: 'ymd',
          developerTools: true,
          pushGatewayUrl: gateway,
          pushVapidKey: 'BCnS4Sb',
          pushAppId: 'org.example.web',
        },
      },
    })
  );

  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveAccessibleDescription(expect.stringContaining(gateway));
  expect(preferences.dateFormat).toBe('dmy');

  await user.click(within(dialog).getByRole('button', { name: 'Import settings' }));
  await vi.waitFor(() => {
    expect(preferences.dateFormat).toBe('ymd');
  });
  expect(preferences.pushGatewayUrl).toBe(gateway);
  expect(preferences.pushAppId).toBe('org.example.web');
  expect(preferences.developerTools).toBe(false);
});

test('rejects a file that is not a settings file', async () => {
  render(SettingsFile);
  await choose(JSON.stringify({ 'moe.sable.next.workspace': { v: 1, settings: {} } }));

  expect(await screen.findByText(/not a Sable settings file/)).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
