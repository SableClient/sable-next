import { expect, test } from 'vitest';

import {
  isValidPowerLevel,
  MAX_POWER_LEVEL,
  MIN_POWER_LEVEL,
  parsePowerLevelInput,
  parsePowerLevelTags,
  tagForLevel,
  withPowerLevelTag,
} from './power-level-tags';

test('a valid tag map is read with its name and colour', () => {
  const tags = parsePowerLevelTags({
    '100': { name: 'Admin', color: '#0088ff' },
    '50': { name: 'Moderator' },
  });

  expect(tagForLevel(tags, 100)).toEqual({ name: 'Admin', color: '#0088ff' });
  expect(tagForLevel(tags, 50)).toEqual({ name: 'Moderator', color: null });
  expect(tagForLevel(tags, 0)).toBeNull();
});

test('hostile content does not crash and yields no tags', () => {
  expect(parsePowerLevelTags(null)).toEqual({});
  expect(parsePowerLevelTags(undefined)).toEqual({});
  expect(parsePowerLevelTags('not an object')).toEqual({});
  expect(parsePowerLevelTags([1, 2, 3])).toEqual({});
  expect(parsePowerLevelTags({ '100': 'not an object' })).toEqual({});
  expect(parsePowerLevelTags({ '100': { name: 42 } })).toEqual({});
  expect(parsePowerLevelTags({ '100': { name: '  ' } })).toEqual({});
  expect(parsePowerLevelTags({ notALevel: { name: 'Admin' } })).toEqual({});
});

test('an invalid colour falls back to no colour rather than an unvalidated string', () => {
  const tags = parsePowerLevelTags({ '100': { name: 'Admin', color: 'javascript:alert(1)' } });
  expect(tagForLevel(tags, 100)).toEqual({ name: 'Admin', color: null });
});

test('writing a tag preserves other entries and unknown fields on the same entry', () => {
  const content = {
    '100': { name: 'Admin', color: '#0088ff', icon: { key: 'mxc://server/abc' } },
    '50': { name: 'Moderator' },
  };

  const next = withPowerLevelTag(content, 100, { name: 'Owner', color: '#ff0000' });

  expect(next['100']).toEqual({
    name: 'Owner',
    color: '#ff0000',
    icon: { key: 'mxc://server/abc' },
  });
  expect(next['50']).toEqual({ name: 'Moderator' });
});

test('writing a tag with no colour clears a previously set colour', () => {
  const content = { '100': { name: 'Admin', color: '#0088ff' } };
  const next = withPowerLevelTag(content, 100, { name: 'Admin', color: null });

  expect(next['100']).toEqual({ name: 'Admin', color: undefined });
});

test('writing null removes the entry', () => {
  const content = { '100': { name: 'Admin' }, '50': { name: 'Moderator' } };
  const next = withPowerLevelTag(content, 100, null);

  expect(next).toEqual({ '50': { name: 'Moderator' } });
});

test('writing against hostile raw content starts fresh rather than throwing', () => {
  expect(withPowerLevelTag(null, 100, { name: 'Admin', color: null })).toEqual({
    '100': { name: 'Admin', color: undefined },
  });
  expect(withPowerLevelTag('nonsense', 100, { name: 'Admin', color: null })).toEqual({
    '100': { name: 'Admin', color: undefined },
  });
});

test('a power level is only valid within the safe integer range', () => {
  expect(isValidPowerLevel(0)).toBe(true);
  expect(isValidPowerLevel(100)).toBe(true);
  expect(isValidPowerLevel(MIN_POWER_LEVEL)).toBe(true);
  expect(isValidPowerLevel(MAX_POWER_LEVEL)).toBe(true);
  expect(isValidPowerLevel(MAX_POWER_LEVEL + 1)).toBe(false);
  expect(isValidPowerLevel(1.5)).toBe(false);
});

test('parsing the numeric input rejects non-integers and levels above the account', () => {
  expect(parsePowerLevelInput('75', 100)).toEqual({ valid: true, level: 75 });
  expect(parsePowerLevelInput(' -5 ', 100)).toEqual({ valid: true, level: -5 });
  expect(parsePowerLevelInput('abc', 100)).toEqual({ valid: false, reason: 'not-a-number' });
  expect(parsePowerLevelInput('12.5', 100)).toEqual({ valid: false, reason: 'not-a-number' });
  expect(parsePowerLevelInput('', 100)).toEqual({ valid: false, reason: 'not-a-number' });
  expect(parsePowerLevelInput('101', 100)).toEqual({ valid: false, reason: 'exceeds-own' });
});
