import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const buttonCss = readFileSync(fileURLToPath(new URL('./button.css', import.meta.url)), 'utf8');
const combobox = readFileSync(fileURLToPath(new URL('./Combobox.svelte', import.meta.url)), 'utf8');
const formControlCss = readFileSync(
  fileURLToPath(new URL('./form-control.css', import.meta.url)),
  'utf8'
);
const optionCards = readFileSync(
  fileURLToPath(new URL('./OptionCards.svelte', import.meta.url)),
  'utf8'
);
const settingsRow = readFileSync(
  fileURLToPath(new URL('./SettingsRow.svelte', import.meta.url)),
  'utf8'
);

test('nested controls use the inherited inner radius', () => {
  expect(formControlCss).toContain('border-radius: var(--radius-inner);');
  expect(buttonCss).toContain('border-radius: var(--radius-inner);');
  expect(optionCards).toContain('border-radius: var(--radius-inner);');
  expect(settingsRow).toContain('border-radius: var(--radius-inner);');
  expect(combobox).toContain('border-radius: var(--radius-inner);');
});
