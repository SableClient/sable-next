// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { serializeComposer, serializePlain, textDoc } from './editor/serialize';
import { parseMfmColor, utcFallbackLabel } from './time-markup';

test('a colour looks for its close within a bounded span', () => {
  expect(parseMfmColor(`$[fg.color=f00 ${'a'.repeat(100)}]`)?.text).toBe('a'.repeat(100));
  expect(parseMfmColor(`$[fg.color=f00 ${'a'.repeat(5000)}]`)).toBeNull();
});

test('a long run of unclosed colours stays literal', { timeout: 30_000 }, () => {
  const source = '$[fg.color=f00 x '.repeat(5000);
  for (const serialize of [serializeComposer, serializePlain]) {
    const message = serialize(textDoc(source));
    expect(message.body).toBe(source.trim());
    expect(message.formatted).toBeNull();
  }
});

test('the fallback label keeps the offset the time was written in', () => {
  const label = utcFallbackLabel('2026-09-23T14:05:00+02:00');
  expect(label).toContain('14:05');
  expect(label).toMatch(/\(UTC\+02:00\)$/);
});
