// @vitest-environment happy-dom

import i18next from 'i18next';
import { flushSync } from 'svelte';
import { expect, test } from 'vitest';

import { i18n, setAppName, t } from './i18n.js';
import { preferences } from './settings/preferences.svelte.js';

test('i18n.t reads re-run when a bundle adds a translation', () => {
  const seen: string[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(i18n.t('probe', { ns: 'zz' }));
    });
  });

  try {
    flushSync();
    expect(seen.at(-1)).toBe('probe');

    i18next.addResource('en', 'zz', 'probe', 'Probe');
    flushSync();

    expect(seen.at(-1)).toBe('Probe');
  } finally {
    stop();
    i18next.removeResourceBundle('en', 'zz');
  }
});

test('setAppName re-runs t() reads that use {{appName}}', () => {
  const seen: string[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(t('auth.welcome'));
    });
  });

  try {
    flushSync();
    expect(seen.at(-1)).toBe('Welcome to Sable');

    setAppName('Acme');
    flushSync();
    expect(seen.at(-1)).toBe('Welcome to Acme');
  } finally {
    stop();
    setAppName('Sable');
  }
});

test('translation keys only show while developer tools are on', () => {
  preferences.showTranslationStrings = true;
  try {
    expect(i18n.t('timeline.members')).toBe('Members');
    preferences.developerTools = true;
    expect(i18n.t('timeline.members')).toBe('timeline.members');
  } finally {
    preferences.showTranslationStrings = false;
    preferences.developerTools = false;
  }
});
