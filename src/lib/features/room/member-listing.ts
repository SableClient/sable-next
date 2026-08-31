import type { MemberView } from '#src/generated/MemberView';
import type { MembershipView } from '#src/generated/MembershipView';

export type MemberSort = 'name-asc' | 'name-desc' | 'newest' | 'oldest';
export type MembershipFilter = 'join' | 'invite' | 'leave' | 'kick' | 'ban';

export const MEMBER_SORTS: readonly MemberSort[] = ['name-asc', 'name-desc', 'newest', 'oldest'];
export const MEMBERSHIP_FILTERS: readonly MembershipFilter[] = [
  'join',
  'invite',
  'leave',
  'kick',
  'ban',
];

export const MEMBER_SORT_LABELS: Record<MemberSort, string> = {
  'name-asc': 'timeline.memberSortNameAsc',
  'name-desc': 'timeline.memberSortNameDesc',
  newest: 'timeline.memberSortNewest',
  oldest: 'timeline.memberSortOldest',
};

export const MEMBERSHIP_FILTER_LABELS: Record<MembershipFilter, string> = {
  join: 'timeline.memberFilterJoined',
  invite: 'timeline.memberFilterInvited',
  leave: 'timeline.memberFilterLeft',
  kick: 'timeline.memberFilterKicked',
  ban: 'timeline.memberFilterBanned',
};

export function membershipFor(filter: MembershipFilter): MembershipView {
  return filter === 'kick' ? 'leave' : filter;
}

export function memberName(member: MemberView): string {
  return member.display_name ?? member.user_id;
}

export function matchesFilter(member: MemberView, filter: MembershipFilter): boolean {
  if (member.membership !== membershipFor(filter)) return false;
  if (filter === 'leave') return !member.kicked;
  if (filter === 'kick') return member.kicked;
  return true;
}

function compare(sort: MemberSort): (left: MemberView, right: MemberView) => number {
  switch (sort) {
    case 'name-desc':
      return (left, right) => byName(right, left);
    case 'newest':
      return (left, right) => (right.member_ts ?? 0) - (left.member_ts ?? 0);
    case 'oldest':
      return (left, right) => (left.member_ts ?? 0) - (right.member_ts ?? 0);
    default:
      return byName;
  }
}

function byName(left: MemberView, right: MemberView): number {
  return memberName(left).localeCompare(memberName(right), undefined, { sensitivity: 'base' });
}

export interface MemberGroup {
  level: number;
  members: MemberView[];
}

export function groupMembers(members: readonly MemberView[], sort: MemberSort): MemberGroup[] {
  const ordered = [...members]
    .toSorted(compare(sort))
    .sort((left, right) => right.power_level - left.power_level);

  const groups: MemberGroup[] = [];
  for (const member of ordered) {
    const current = groups.at(-1);
    if (current && current.level === member.power_level) current.members.push(member);
    else groups.push({ level: member.power_level, members: [member] });
  }
  return groups;
}
