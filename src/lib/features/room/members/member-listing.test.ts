import type { MemberView } from '#src/generated/protocol';
import { describe, expect, it } from 'vitest';

import { groupMembers, limitGroups, matchesFilter, membershipFor } from './member-listing';

function member(overrides: Partial<MemberView> & { user_id: string }): MemberView {
  return {
    display_name: null,
    avatar_url: null,
    power_level: 0,
    membership: 'join',
    member_ts: null,
    kicked: false,
    service: false,
    ...overrides,
  };
}

const amy = member({ user_id: '@amy:e.org', display_name: 'Amy', member_ts: 3 });
const bob = member({ user_id: '@bob:e.org', display_name: 'Bob', member_ts: 1 });
const cid = member({ user_id: '@cid:e.org', display_name: 'Cid', power_level: 100, member_ts: 2 });

const allOnline = (): boolean => true;

describe('groupMembers', () => {
  it('groups by power level, highest first', () => {
    expect(groupMembers([amy, bob, cid], 'name-asc', allOnline)).toEqual([
      { key: '100', level: 100, members: [cid] },
      { key: '0', level: 0, members: [amy, bob] },
    ]);
  });

  it('orders within a group by the chosen sort', () => {
    const names = (sort: Parameters<typeof groupMembers>[1]): string[] =>
      groupMembers([amy, bob, cid], sort, allOnline)
        .flatMap((group) => group.members)
        .map((entry) => entry.display_name ?? '');

    expect(names('name-asc')).toEqual(['Cid', 'Amy', 'Bob']);
    expect(names('name-desc')).toEqual(['Cid', 'Bob', 'Amy']);
    expect(names('newest')).toEqual(['Cid', 'Amy', 'Bob']);
    expect(names('oldest')).toEqual(['Cid', 'Bob', 'Amy']);
  });

  it('sinks members without presence under one offline group', () => {
    const online = (userId: string): boolean => userId === amy.user_id;
    const dee = member({ user_id: '@dee:e.org', display_name: 'Dee', power_level: -1 });

    expect(groupMembers([amy, bob, dee], 'name-asc', online)).toEqual([
      { key: '0', level: 0, members: [amy] },
      { key: 'offline', level: null, members: [bob, dee] },
    ]);
  });

  it('keeps elevated members under their role whatever their presence', () => {
    const offline = (): boolean => false;

    expect(groupMembers([amy, bob, cid], 'name-asc', offline)).toEqual([
      { key: '100', level: 100, members: [cid] },
      { key: 'offline', level: null, members: [amy, bob] },
    ]);
  });

  it('keeps elevated members on the first page in a large offline room', () => {
    const members = Array.from({ length: 4000 }, (_, index) =>
      member({
        user_id: `@user${String(index).padStart(4, '0')}:e.org`,
        power_level: index === 3999 ? 100 : index === 2999 ? 50 : 0,
      })
    );
    const groups = groupMembers(members, 'name-asc', () => false);

    expect(groups.map((group) => [group.level, group.members.length])).toEqual([
      [100, 1],
      [50, 1],
      [null, 3998],
    ]);
    expect(limitGroups(groups, 30).map((group) => [group.level, group.members.length])).toEqual([
      [100, 1],
      [50, 1],
      [null, 28],
    ]);
  });

  it('lists from the level the room sets, whatever their presence', () => {
    const offline = (): boolean => false;

    expect(groupMembers([amy, bob, cid], 'name-asc', offline, 101)).toEqual([
      { key: 'offline', level: null, members: [amy, bob, cid] },
    ]);
    expect(groupMembers([amy, bob, cid], 'name-asc', offline, 0)).toEqual([
      { key: '100', level: 100, members: [cid] },
      { key: '0', level: 0, members: [amy, bob] },
    ]);
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

describe('limitGroups', () => {
  const groups = groupMembers([amy, bob, cid], 'name-asc', allOnline);

  it('cuts across groups once the limit is reached', () => {
    expect(limitGroups(groups, 2)).toEqual([
      { key: '100', level: 100, members: [cid] },
      { key: '0', level: 0, members: [amy] },
    ]);
  });

  it('drops a group it cannot reach and keeps everything under the limit', () => {
    expect(limitGroups(groups, 1)).toEqual([{ key: '100', level: 100, members: [cid] }]);
    expect(limitGroups(groups, 10)).toEqual(groups);
  });
});
