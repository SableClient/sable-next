import { expect, test } from 'vitest';

import {
  canonicalDatetime,
  formatSenderWall,
  formatUtcTimestamp,
  isOpaqueMatrixColor,
  matrixColorToMfmHex,
  parseMfmColor,
  parseMfmColorArgs,
  parseZonedDatetime,
  unixtimeDatetime,
  utcFallbackLabel,
} from './time-markup';

test('only accepts opaque Matrix color attributes', () => {
  expect(isOpaqueMatrixColor('#fff')).toBe(true);
  expect(isOpaqueMatrixColor('#ff0000')).toBe(true);
  expect(isOpaqueMatrixColor('#ffff')).toBe(false);
  expect(isOpaqueMatrixColor('#ff000080')).toBe(false);
  expect(isOpaqueMatrixColor('transparent')).toBe(false);
  expect(isOpaqueMatrixColor('rgba(0, 0, 0, 0)')).toBe(false);
});

test('canonicalises the MSC offset form and rejects an unzoned time', () => {
  expect(canonicalDatetime('2026-09-17T09:00-0200')).toBe('2026-09-17T09:00:00-02:00');
  expect(canonicalDatetime('2026-09-17T15:00:00.000Z')).toBe('2026-09-17T15:00:00Z');
  expect(canonicalDatetime('2026-09-17T09:00')).toBeNull();
  expect(canonicalDatetime('2026-09-17')).toBeNull();
});

test.each([
  '2026-09-17T09:00:00.fooZ',
  '2026-09-17T09:00:00.Z',
  '2026-09-17T09:00:00+02::00',
  '2026-09-17T09:00:00+2:000',
  '2026-9-017T09:00:00Z',
  '2026-09-17T9:00:00Z',
  '2026-09-17T09:0:00Z',
  '2026-09-17T09:00:0Z',
])('rejects malformed zoned datetime %s', (value) => {
  expect(canonicalDatetime(value)).toBeNull();
});

test('turns a unix timestamp into a UTC datetime', () => {
  expect(unixtimeDatetime('1789657200')).toBe('2026-09-17T15:00:00Z');
  expect(utcFallbackLabel('2026-09-17T15:00:00Z')).toBe('17 Sep 2026, 15:00 (UTC)');
  expect(unixtimeDatetime('99999999999999')).toBeNull();
});

test('formats the instant in UTC regardless of the viewer zone', () => {
  expect(formatUtcTimestamp(Date.parse('2026-09-17T15:00:00Z'), true)).toContain('15:00');
});

test('parses Misskey color arguments the way Sable v1 does', () => {
  expect(parseMfmColorArgs('fg.color=ff0000')).toEqual({ fg: '#ff0000' });
  expect(parseMfmColorArgs('fg.color=ff0000 bg.color=00ff00')).toEqual({
    fg: '#ff0000',
    bg: '#00ff00',
  });
  expect(parseMfmColorArgs('fg.color=fff')).toEqual({ fg: '#ffffff' });
  expect(parseMfmColor('$[fg.color=ff0000 red text]')?.text).toBe('red text');
  expect(parseMfmColor('$[fg.color=f00.red]')).toBeNull();
  expect(parseMfmColor('$[fg.color=ff00 no color]')).toBeNull();
  expect(parseMfmColor('$[fg.color=ff0000ff no color]')).toBeNull();
});

test('keeps nested color functions intact', () => {
  const parsed = parseMfmColor('$[fg.color=ff0000 $[bg.color=00ff00 both]]');

  expect(parsed?.text).toBe('$[bg.color=00ff00 both]');
  expect(parsed?.raw).toBe('$[fg.color=ff0000 $[bg.color=00ff00 both]]');
});

test('serialises short Matrix colors without changing them to black', () => {
  expect(matrixColorToMfmHex('#fff')).toBe('ffffff');
  expect(matrixColorToMfmHex('#0f0')).toBe('00ff00');
});

test('formats years below 100 without the Date.UTC 1900 offset', () => {
  const zoned = parseZonedDatetime('0001-01-01T00:00:00Z');

  expect(zoned && formatSenderWall(zoned, true)).toContain('1');
  expect(zoned && formatSenderWall(zoned, true)).not.toContain('1901');
});
