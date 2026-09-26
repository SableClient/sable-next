// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const prefs = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('#lib/settings/preferences.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPreference: prefs.setPreference,
}));

import AppearanceSetupCard from './AppearanceSetupCard.svelte';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('shows both modes and follows the device when its mode is selected', async () => {
  const onComplete = vi.fn();
  const instance = mount(AppearanceSetupCard, { target: document.body, props: { onComplete } });
  flushSync();

  expect(document.body.textContent).toContain('Browse more themes');
  const choices = [...document.querySelectorAll<HTMLButtonElement>('.mode-choices [role="radio"]')];
  expect(choices.map((choice) => choice.textContent.trim())).toEqual(['Light', 'Dark']);
  expect(choices.map((choice) => choice.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  choices[1]?.click();
  expect(prefs.setPreference).toHaveBeenCalledWith('theme', 'dark');
  choices[0]?.click();
  expect(prefs.setPreference).toHaveBeenCalledWith('theme', 'system');

  [...document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === 'Continue')
    ?.click();
  expect(onComplete).toHaveBeenCalledOnce();
  await unmount(instance);
});
