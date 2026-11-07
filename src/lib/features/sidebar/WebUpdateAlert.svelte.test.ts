// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { i18n } from '#lib/i18n.js';
import { webUpdateState } from '#lib/platform/web-updates.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import Harness from './WebUpdateAlertHarness.test.svelte';

afterEach(() => {
  webUpdateState.generation = 0;
  preferences.autoUpdateCheck = true;
  vi.unstubAllGlobals();
});

test('a waiting web bundle is announced in the browser', async () => {
  preferences.autoUpdateCheck = false;
  render(Harness);

  webUpdateState.generation += 1;
  await tick();

  expect(
    screen.getByText(i18n.t('settings.webUpdateAlertBody', { appName: 'Sable' }))
  ).toBeInTheDocument();
});

test('the desktop app leaves updates to its own alert', async () => {
  vi.stubGlobal('sableElectron', { platform: 'linux' });
  render(Harness);

  webUpdateState.generation += 1;
  await tick();

  expect(
    screen.queryByText(i18n.t('settings.webUpdateAlertBody', { appName: 'Sable' }))
  ).toBeNull();
});
