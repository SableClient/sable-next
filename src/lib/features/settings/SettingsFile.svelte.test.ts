// @vitest-environment happy-dom

import { mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const history = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));

vi.mock('$app/state', () => ({
  page: { url: { pathname: '/settings' }, params: {}, state: history.state },
}));
vi.mock('$app/navigation', () => ({
  goto: (_href: string, options?: { state?: Record<string, unknown> }) => {
    Object.assign(history.state, options?.state);
    return Promise.resolve();
  },
}));

import { applyPreferences, preferences } from '#lib/settings/preferences.svelte.js';

import SettingsFile from './SettingsFile.svelte';

const initial = { ...preferences };
const gateway = 'https://push.example.org/_matrix/push/v1/notify';

afterEach(() => {
  applyPreferences(initial);
  document.body.replaceChildren();
});

function choose(text: string): void {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('Missing file input');
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [new File([text], 'settings.json', { type: 'application/json' })],
  });
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

test('applies a settings file only after confirmation that names the gateway', async () => {
  applyPreferences({ ...initial, dateFormat: 'dmy', developerTools: false });
  const instance = mount(SettingsFile, { target: document.body });
  try {
    choose(
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

    await vi.waitFor(() => {
      expect(document.querySelector('.confirm')?.textContent).toContain(gateway);
    });
    expect(preferences.dateFormat).toBe('dmy');

    document.querySelector<HTMLButtonElement>('.confirm .btn-danger')?.click();
    await vi.waitFor(() => {
      expect(preferences.dateFormat).toBe('ymd');
    });
    expect(preferences.pushGatewayUrl).toBe(gateway);
    expect(preferences.pushAppId).toBe('org.example.web');
    expect(preferences.developerTools).toBe(false);
  } finally {
    await unmount(instance);
  }
});

test('rejects a file that is not a settings file', async () => {
  const instance = mount(SettingsFile, { target: document.body });
  try {
    choose(JSON.stringify({ 'moe.sable.next.workspace': { v: 1, settings: {} } }));

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('not a Sable settings file');
    });
    expect(document.querySelector('.confirm')).toBeNull();
  } finally {
    await unmount(instance);
  }
});
