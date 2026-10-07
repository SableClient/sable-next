// @vitest-environment happy-dom

import { flushSync } from 'svelte';
import { expect, test } from 'vitest';

import { currentLocale, setLanguage, t } from './i18n.js';

test('a language change re-runs t() and currentLocale() reads', async () => {
  const seen: string[] = [];
  const locales: string[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen.push(t('timeline.members'));
      locales.push(currentLocale());
    });
  });

  try {
    flushSync();
    expect(seen.at(-1)).toBe('Members');
    expect(locales.at(-1)).toBe('en');

    await setLanguage('fr');
    flushSync();

    expect(seen.at(-1)).toBe('Membres');
    expect(locales.at(-1)).toBe('fr');
  } finally {
    stop();
    await setLanguage('en');
  }
});
