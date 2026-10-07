import { expect, test } from 'vitest';

import en from '../locales/en.json';
import { localeLabel } from './locales';

test('names every language with a capital, even where the language itself does not', () => {
  expect(localeLabel('fr')).toBe('Français');
  expect(localeLabel('en')).toBe('English');
});

test('shared words live under common instead of being repeated per feature', () => {
  const flat = (node: Record<string, unknown>, prefix = ''): [string, string][] =>
    Object.entries(node).flatMap(([key, value]) =>
      typeof value === 'string'
        ? [[prefix + key, value] as [string, string]]
        : flat(value as Record<string, unknown>, `${prefix}${key}.`)
    );
  const entries = flat(en);
  const common = new Map(
    entries.filter(([key]) => key.startsWith('common.')).map(([k, v]) => [v, k])
  );
  const repeats = entries.filter(([key, value]) => !key.startsWith('common.') && common.has(value));
  expect(repeats).toEqual([]);
});
