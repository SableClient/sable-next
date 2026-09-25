// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/ui/primitives/Select.svelte', async () => ({
  default: (await import('./SelectStub.test.svelte')).default,
}));
const prefs = vi.hoisted(() => ({ setPreference: vi.fn() }));
vi.mock('#lib/settings/preferences.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPreference: prefs.setPreference,
}));

import AppearanceSetupCard from './AppearanceSetupCard.svelte';

function render() {
  const props = { onComplete: vi.fn(), onSkip: vi.fn() };
  const instance = mount(AppearanceSetupCard, { target: document.body, props });
  flushSync();
  return { instance, ...props };
}

const option = (select: string, name: string) =>
  [...document.querySelectorAll(`[data-select="${select}"] button`)].find(
    (element) => element.textContent.trim() === name
  ) as HTMLButtonElement | undefined;

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('starts from the current settings', async () => {
  const { instance } = render();

  expect(document.querySelector('[data-select="setup-theme"]')?.getAttribute('data-value')).toBe(
    'system'
  );
  expect(document.querySelector('[data-select="setup-layout"]')?.getAttribute('data-value')).toBe(
    'modern'
  );
  expect(document.querySelector('[data-select="setup-reply"]')?.getAttribute('data-value')).toBe(
    'connected'
  );
  expect(document.body.textContent).toContain('Sable (default)');

  await unmount(instance);
});

test('each choice is written to the same setting as Settings', async () => {
  const { instance, onComplete } = render();

  option('setup-theme', 'Dark')?.click();
  option('setup-layout', 'Bubble')?.click();
  option('setup-reply', 'Compact card')?.click();

  expect(prefs.setPreference.mock.calls).toEqual([
    ['theme', 'dark'],
    ['layout', 'bubble'],
    ['replyPreviewStyle', 'compact'],
  ]);
  [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === 'Continue')
    ?.click();
  expect(onComplete).toHaveBeenCalledOnce();

  await unmount(instance);
});
