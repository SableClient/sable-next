// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
const prefs = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('#lib/settings/preferences.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPreference: prefs.setPreference,
}));

import { core } from '#lib/core/__mocks__/context.js';

const accountData = vi.fn<(type: string) => Promise<unknown>>(() => Promise.resolve(null));
Object.assign(core, { accountData });

import SettingsSyncCard from './SettingsSyncCard.svelte';

async function render() {
  const props = { onComplete: vi.fn(), onSkip: vi.fn() };
  const instance = mount(SettingsSyncCard, { target: document.body, props });
  await vi.waitFor(() => {
    expect(button(/Turn on sync|Use synced settings/)?.disabled).toBe(false);
  });
  return { instance, ...props };
}

const button = (name: RegExp) =>
  [...document.querySelectorAll('button')].find((element) => name.test(element.textContent.trim()));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('says the data is unencrypted before offering to turn sync on', async () => {
  const { instance, onComplete } = await render();

  expect(accountData).toHaveBeenCalledWith('moe.sable.next.settings');
  expect(document.body.textContent).toContain("isn't encrypted");
  button(/^Turn on sync$/)?.click();
  expect(prefs.setPreference).toHaveBeenCalledWith('settingsSync', true);
  expect(onComplete).toHaveBeenCalledOnce();

  await unmount(instance);
});

test('an account with synced settings is offered them to adopt', async () => {
  accountData.mockResolvedValueOnce({ version: 1, settings: {} });
  const { instance } = await render();

  expect(document.body.textContent).toContain('already has settings synced');
  expect(button(/^Use synced settings$/)).toBeDefined();

  await unmount(instance);
});

test('not now leaves sync off', async () => {
  const { instance, onSkip } = await render();

  button(/^Not now$/)?.click();
  flushSync();
  expect(onSkip).toHaveBeenCalledOnce();
  expect(prefs.setPreference).not.toHaveBeenCalled();

  await unmount(instance);
});
