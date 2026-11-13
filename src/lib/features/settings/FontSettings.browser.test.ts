import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/platform/overlay-back.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/overlay-back.svelte.js')>()),
  holdOverlayBack: () => {},
}));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
import {
  applyCustomTheme,
  applyFontFamily,
  applyFontFamilyMono,
  applyQuickCss,
} from '#lib/settings/theme.js';
import FontSettings from './FontSettings.svelte';

afterEach(() => {
  setPreference('fontFamily', '');
  setPreference('fontFamilyMono', '');
  applyFontFamily('');
  applyFontFamilyMono('');
  applyCustomTheme(undefined);
  applyQuickCss('');
  localStorage.removeItem('sable-preferences');
});

test('mobile: follows the device font without entering its name', async () => {
  await page.viewport(390, 844);
  const screen = await render(FontSettings);
  await userEvent.click(screen.getByRole('button', { name: 'Regular font', exact: true }));
  await userEvent.click(
    screen.getByRole('dialog', { name: 'Regular font', exact: true }).getByRole('radio', {
      name: 'System',
      exact: true,
    })
  );

  await expect.poll(() => preferences.fontFamily).toBe('system-ui');
  await expect
    .element(screen.getByRole('button', { name: 'Regular font', exact: true }))
    .toHaveTextContent('System');
  expect(screen.getByRole('textbox').elements()).toHaveLength(0);
  const stored = JSON.parse(localStorage.getItem('sable-preferences') ?? '{}') as {
    fontFamily?: string;
  };
  expect(stored.fontFamily).toBe('system-ui');
});

test('desktop: keeps an existing custom font and its draft when switching modes', async () => {
  await page.viewport(1280, 900);
  setPreference('fontFamily', 'IBM Plex Mono');
  const screen = await render(FontSettings);
  const field = screen.getByRole('textbox', { name: 'Font name', exact: true });
  await expect.element(field).toHaveValue('IBM Plex Mono');

  await userEvent.clear(field);
  await expect.element(field).toBeVisible();
  await userEvent.fill(field, 'IBM Plex Mono');
  await userEvent.click(screen.getByRole('combobox', { name: 'Regular font', exact: true }));
  await userEvent.click(screen.getByRole('option', { name: 'System', exact: true }));
  await expect.poll(() => preferences.fontFamily).toBe('system-ui');
  expect(screen.getByRole('textbox').elements()).toHaveLength(0);

  await userEvent.click(screen.getByRole('combobox', { name: 'Regular font', exact: true }));
  await userEvent.click(screen.getByRole('option', { name: 'Custom', exact: true }));
  await expect.element(field).toHaveValue('IBM Plex Mono');
  await expect.poll(() => preferences.fontFamily).toBe('IBM Plex Mono');

  await userEvent.click(screen.getByRole('combobox', { name: 'Regular font', exact: true }));
  await userEvent.click(screen.getByRole('option', { name: 'Default', exact: true }));
  await expect.poll(() => preferences.fontFamily).toBe('');
});

test('mobile: custom starts with an editable empty field and mono has its own system choice', async () => {
  await page.viewport(390, 844);
  const screen = await render(FontSettings);
  await userEvent.click(screen.getByRole('button', { name: 'Regular font', exact: true }));
  await userEvent.click(
    screen
      .getByRole('dialog', { name: 'Regular font', exact: true })
      .getByRole('radio', { name: 'Custom', exact: true })
  );
  const field = screen.getByRole('textbox', { name: 'Font name', exact: true });
  await expect.element(field).toHaveValue('');
  await expect.element(field).toHaveFocus();
  await userEvent.fill(field, 'IBM Plex Mono');
  await expect.poll(() => preferences.fontFamily).toBe('IBM Plex Mono');

  await userEvent.click(screen.getByRole('button', { name: 'Monospaced font', exact: true }));
  await userEvent.click(
    screen
      .getByRole('dialog', { name: 'Monospaced font', exact: true })
      .getByRole('radio', { name: 'System', exact: true })
  );
  await expect.poll(() => preferences.fontFamilyMono).toBe('monospace');
  expect(preferences.fontFamily).toBe('IBM Plex Mono');
});

test('font preferences beat theme declarations on body and restore the theme when cleared', () => {
  applyCustomTheme(
    'body { --font-family: "Theme Sans", sans-serif; --font-family-mono: "Theme Mono", monospace; font-family: "Theme Sans", sans-serif; }'
  );
  const regular = () => getComputedStyle(document.body).fontFamily;
  const code = document.createElement('code');
  code.style.fontFamily = 'var(--font-family-mono)';
  document.body.append(code);
  try {
    applyFontFamily('IBM Plex Mono');
    applyFontFamilyMono('ui-monospace');
    expect(regular()).toBe(
      '"IBM Plex Mono", "Nunito Variable", Twemoji_DISABLED, "Vazirmatn Variable", sans-serif'
    );
    expect(getComputedStyle(code).fontFamily).toBe(
      'ui-monospace, "Cascadia Code Variable", monospace'
    );
    applyFontFamily('system-ui');
    expect(regular()).toContain('system-ui');
    expect(regular()).not.toContain('IBM Plex Mono');
    applyFontFamily('');
    applyFontFamilyMono('');
    expect(regular()).toBe('"Theme Sans", sans-serif');
    expect(getComputedStyle(code).fontFamily).toBe('"Theme Mono", monospace');
    applyFontFamily('system-ui');
    applyQuickCss('body { font-family: serif !important; }');
    expect(regular()).toBe('serif');
  } finally {
    code.remove();
  }
});

test.each([
  ['Regular font', 'system-ui', 'fontFamily'],
  ['Monospaced font', 'monospace', 'fontFamilyMono'],
] as const)(
  'desktop: %s keeps system keywords editable in Custom mode',
  async (label, family, key) => {
    await page.viewport(1280, 900);
    setPreference(key, family);
    const screen = await render(FontSettings);
    const selector = screen.getByRole('combobox', { name: label, exact: true });
    await expect.element(selector).toHaveTextContent('System');
    await userEvent.click(selector);
    await userEvent.click(screen.getByRole('option', { name: 'Custom', exact: true }));
    const field = screen.getByRole('textbox', { name: 'Font name', exact: true });
    await userEvent.fill(field, family);
    await expect.element(field).toHaveValue(family);
    await expect.element(selector).toHaveTextContent('Custom');
    await expect.poll(() => preferences[key]).toBe(family);

    await userEvent.click(selector);
    await userEvent.click(screen.getByRole('option', { name: 'System', exact: true }));
    await expect.element(selector).toHaveTextContent('System');
    await userEvent.click(selector);
    await userEvent.click(screen.getByRole('option', { name: 'Custom', exact: true }));
    await expect.element(field).toHaveValue(family);
    await expect.element(field).toHaveFocus();
    await userEvent.fill(field, 'IBM Plex Mono');
    await expect.poll(() => preferences[key]).toBe('IBM Plex Mono');
  }
);
