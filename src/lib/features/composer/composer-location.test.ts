import { expect, test } from 'vitest';

import { coordinate, geoUriFor } from './composer-location';

test('a fix becomes an RFC 5870 geo URI', () => {
  expect(geoUriFor(48.8584, 2.2945)).toBe('geo:48.8584,2.2945');
});

test('absurd precision is rounded off', () => {
  expect(geoUriFor(48.8584371234, 2.2944819876)).toBe('geo:48.858437,2.294482');
});

test.each([
  ['latitude past the pole', 91, 0],
  ['latitude past the south pole', -91, 0],
  ['longitude past the date line', 0, 181],
  ['not a number', Number.NaN, 0],
  ['infinite', Number.POSITIVE_INFINITY, 0],
])('%s is refused', (_name, latitude, longitude) => {
  expect(geoUriFor(latitude, longitude)).toBeNull();
});

test('the poles and the date line are in range', () => {
  expect(geoUriFor(90, 180)).toBe('geo:90,180');
  expect(geoUriFor(-90, -180)).toBe('geo:-90,-180');
});

test('an empty field is not zero', () => {
  expect(coordinate('')).toBeNaN();
  expect(coordinate('  ')).toBeNaN();
  expect(coordinate('0')).toBe(0);
  expect(coordinate(' 2.29 ')).toBe(2.29);
});
