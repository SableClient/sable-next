import { expect, test } from 'vitest';

import { localeLabel } from './locales';

test('names every language with a capital, even where the language itself does not', () => {
  expect(localeLabel('fr')).toBe('Français');
  expect(localeLabel('en')).toBe('English');
});
