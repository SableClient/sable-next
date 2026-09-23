// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import { setLanguage } from '#lib/i18n.js';

import { serializeComposer, serializePlain, textDoc } from './editor/serialize';
import { parseMfmColor, utcFallbackLabel } from './time-markup';

afterEach(async () => {
  await setLanguage('en');
});

test('a colour looks for its close within a bounded span', () => {
  expect(parseMfmColor(`$[fg.color=f00 ${'a'.repeat(100)}]`)?.text).toBe('a'.repeat(100));
  expect(parseMfmColor(`$[fg.color=f00 ${'a'.repeat(5000)}]`)).toBeNull();
});

test('a long run of unclosed colours stays literal', () => {
  const source = '$[fg.color=f00 x '.repeat(20000);
  for (const serialize of [serializeComposer, serializePlain]) {
    const message = serialize(textDoc(source));
    expect(message.body).toBe(source.trim());
    expect(message.formatted).toBeNull();
  }
});

test('the fallback label follows the reader language', async () => {
  const english = utcFallbackLabel('1970-01-01T00:00:00Z');
  expect(english).toContain('Jan');
  expect(english).toMatch(/\(UTC\)$/);

  await setLanguage('fr');
  expect(utcFallbackLabel('1970-01-01T00:00:00Z')).toContain('janv.');
});

test('the fallback label keeps the offset the time was written in', () => {
  const label = utcFallbackLabel('2026-09-23T14:05:00+02:00');
  expect(label).toContain('14:05');
  expect(label).toMatch(/\(UTC\+02:00\)$/);
});
