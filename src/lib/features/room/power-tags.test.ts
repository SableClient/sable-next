import { describe, expect, it } from 'vitest';

import { powerTag } from './power-tags';

const t = (key: string, options?: Record<string, unknown>): string =>
  options ? `${key}(${JSON.stringify(options)})` : key;

describe('powerTag', () => {
  it('names an exact power level', () => {
    expect(powerTag(100, t).name).toBe('timeline.powerLevelAdmin');
    expect(powerTag(50, t).name).toBe('timeline.powerLevelModerator');
    expect(powerTag(0, t).name).toBe('timeline.powerLevelMember');
    expect(powerTag(-1, t).name).toBe('timeline.powerLevelMuted');
  });

  it('names a room-version-12 creator, whose power level is infinite', () => {
    expect(powerTag(2_147_483_647, t).name).toBe('timeline.powerTagFounder');
  });

  it('prefers the room tag and carries its colour', () => {
    expect(powerTag(100, t, { 100: { name: 'Overlord', color: '#ff0000' } })).toEqual({
      name: 'Overlord',
      color: '#ff0000',
    });
  });

  it('derives an unnamed level from the highest tag below it', () => {
    expect(powerTag(75, t).name).toBe(
      'timeline.powerTagDerived({"tag":"timeline.powerLevelModerator","level":75})'
    );
    expect(powerTag(75, t, { 60: { name: 'Helper', color: null } }).name).toBe(
      'timeline.powerTagDerived({"tag":"Helper","level":75})'
    );
  });

  it('falls back to a team label below every tag', () => {
    expect(powerTag(-5, t).name).toBe('timeline.powerTagTeam({"level":-5})');
  });
});
