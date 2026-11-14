import { expect, test } from 'vitest';

import { matchLocale } from './locales.js';

test('matchLocale maps browser language tags onto shipped locales', () => {
  expect(matchLocale(['fr-FR'])).toBe('fr');
  expect(matchLocale(['pt-BR'])).toBe('pt-BR');
  expect(matchLocale(['pt-PT'])).toBe('pt');
  expect(matchLocale(['zh-CN'])).toBe('zh-Hans');
  expect(matchLocale(['xx-YY', 'de-AT', 'en'])).toBe('de');
  expect(matchLocale(['not a tag', 'zh-TW'])).toBeUndefined();
});
