import type { MemberView } from '#src/generated/MemberView';
import { describe, expect, it } from 'vitest';

import { groupMembers, matchesFilter, membershipFor } from './member-listing';

function member(overrides: Partial<MemberView> & { user_id: string }): MemberView {
  return {
    display_name: null,
    avatar_url: null,
    power_level: 0,
    membership: 'join',
    member_ts: null,
    kicked: false,
    ...overrides,
  };
}

const amy = member({ user_id: '@amy:e.org', display_name: 'Amy', member_ts: 3 });
const bob = member({ user_id: '@bob:e.org', display_name: 'Bob', member_ts: 1 });
const cid = member({ user_id: '@cid:e.org', display_name: 'Cid', power_level: 100, member_ts: 2 });

describe('groupMembers', () => {
  it('groups by power level, highest first', () => {
    expect(groupMembers([amy, bob, cid], 'name-asc')).toEqual([
      { level: 100, members: [cid] },
      { level: 0, members: [amy, bob] },
    ]);
  });

  it('orders within a group by the chosen sort', () => {
    const names = (sort: Parameters<typeof groupMembers>[1]): string[] =>
      groupMembers([amy, bob, cid], sort)
        .flatMap((group) => group.members)
        .map((entry) => entry.display_name ?? '');

    expect(names('name-asc')).toEqual(['Cid', 'Amy', 'Bob']);
    expect(names('name-desc')).toEqual(['Cid', 'Bob', 'Amy']);
    expect(names('newest')).toEqual(['Cid', 'Amy', 'Bob']);
    expect(names('oldest')).toEqual(['Cid', 'Bob', 'Amy']);
  });
});

describe('matchesFilter', () => {
  const left = member({ user_id: '@l:e.org', membership: 'leave' });
  const kicked = member({ user_id: '@k:e.org', membership: 'leave', kicked: true });

  it('splits a leave by who sent it', () => {
    expect(matchesFilter(left, 'leave')).toBe(true);
    expect(matchesFilter(left, 'kick')).toBe(false);
    expect(matchesFilter(kicked, 'kick')).toBe(true);
    expect(matchesFilter(kicked, 'leave')).toBe(false);
  });

  it('asks the server for a leave when kicked members are wanted', () => {
    expect(membershipFor('kick')).toBe('leave');
    expect(membershipFor('ban')).toBe('ban');
  });
});
