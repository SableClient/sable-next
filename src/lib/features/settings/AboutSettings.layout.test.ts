import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const aboutSource = readFileSync(new URL('./AboutSettings.svelte', import.meta.url), 'utf8');
const settingsRowSource = readFileSync(
  new URL('../../ui/primitives/SettingsRow.svelte', import.meta.url),
  'utf8'
);

test('the mobile About header stacks actions inside the viewport', () => {
  expect(aboutSource).toContain('@media (width < 42rem)');
  expect(aboutSource).toContain('flex-direction: column;');
  expect(aboutSource).toContain('grid-template-columns: minmax(0, 1fr);');
});

test('mobile settings row controls can shrink around long values', () => {
  const rowControl = settingsRowSource.match(/\.row-control \{(?<contents>[^}]+)\}/u)?.groups
    ?.contents;

  expect(rowControl).toContain('flex: 1 1 100%;');
  expect(rowControl).toContain('max-width: 100%;');
  expect(rowControl).toContain('min-width: 0;');
});

test('About offers update checks on every platform', () => {
  expect(aboutSource).toContain('aboutCheckForUpdates');
  expect(aboutSource).toContain('checkForUpdates');
  expect(aboutSource).toContain('checkForMobileUpdate');
  expect(aboutSource).toContain('checkForWebUpdate');
});
