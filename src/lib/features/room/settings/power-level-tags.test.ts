import { expect, test } from 'vitest';

import {
  isValidPowerLevel,
  MAX_POWER_LEVEL,
  MIN_POWER_LEVEL,
  parsePowerLevelInput,
} from './power-level-tags';

test('a power level is only valid within the safe integer range', () => {
  expect(isValidPowerLevel(0)).toBe(true);
  expect(isValidPowerLevel(100)).toBe(true);
  expect(isValidPowerLevel(MIN_POWER_LEVEL)).toBe(true);
  expect(isValidPowerLevel(MAX_POWER_LEVEL)).toBe(true);
  expect(isValidPowerLevel(MAX_POWER_LEVEL + 1)).toBe(false);
  expect(isValidPowerLevel(1.5)).toBe(false);
});

test('the founder level is out of range for input', () => {
  expect(parsePowerLevelInput('9007199254740992', MAX_POWER_LEVEL + 1)).toEqual({
    valid: false,
    reason: 'out-of-range',
  });
});

test('parsing the numeric input rejects non-integers and levels above the account', () => {
  expect(parsePowerLevelInput('75', 100)).toEqual({ valid: true, level: 75 });
  expect(parsePowerLevelInput(' -5 ', 100)).toEqual({ valid: true, level: -5 });
  expect(parsePowerLevelInput('abc', 100)).toEqual({ valid: false, reason: 'not-a-number' });
  expect(parsePowerLevelInput('12.5', 100)).toEqual({ valid: false, reason: 'not-a-number' });
  expect(parsePowerLevelInput('', 100)).toEqual({ valid: false, reason: 'not-a-number' });
  expect(parsePowerLevelInput('101', 100)).toEqual({ valid: false, reason: 'exceeds-own' });
});
