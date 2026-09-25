import type { MembershipChangeView, TimelineItemView } from '#src/generated/protocol';

import type { Translate } from './state-event-text';

export type MemberGroupCategory =
  | 'joined'
  | 'left'
  | 'invitation_rejected'
  | 'knocked'
  | 'knock_retracted'
  | 'avatar';

const MEMBERSHIP_CATEGORIES: Partial<Record<MembershipChangeView, MemberGroupCategory>> = {
  joined: 'joined',
  invitation_accepted: 'joined',
  left: 'left',
  invitation_rejected: 'invitation_rejected',
  knocked: 'knocked',
  knock_retracted: 'knock_retracted',
};

const MAX_NAMES = 3;
const SHOWN_WITH_OTHERS = 2;
const MARK = '\u0000';

export function memberGroupCategory(item: TimelineItemView): MemberGroupCategory | null {
  if (item.event_id === null || item.reactions.length > 0) return null;
  const content = item.content;
  if (content.kind === 'membership') {
    return content.reason ? null : (MEMBERSHIP_CATEGORIES[content.change] ?? null);
  }
  if (content.kind === 'profile_change') {
    return content.display_name === null && content.avatar !== null ? 'avatar' : null;
  }
  return null;
}

export interface TimelineUnit {
  item: TimelineItemView;
  index: number;
  group: readonly TimelineItemView[] | null;
}

export function groupMemberEvents(items: readonly TimelineItemView[]): TimelineUnit[] {
  const units: TimelineUnit[] = [];
  let start = 0;
  while (start < items.length) {
    let end = start;
    while (end < items.length && memberGroupCategory(items[end]) !== null) end += 1;
    if (end - start >= 2) {
      units.push({ item: items[end - 1], index: end - 1, group: items.slice(start, end) });
      start = end;
    } else {
      units.push({ item: items[start], index: start, group: null });
      start += 1;
    }
  }
  return units;
}

export interface MemberGroupUser {
  userId: string;
  name: string;
}

export interface MemberGroupSegment {
  category: MemberGroupCategory;
  users: MemberGroupUser[];
}

function groupUser(item: TimelineItemView): MemberGroupUser | null {
  const content = item.content;
  if (content.kind === 'membership') {
    return { userId: content.user_id, name: content.display_name ?? content.user_id };
  }
  if (content.kind === 'profile_change') {
    return { userId: content.user_id, name: item.sender_name ?? content.user_id };
  }
  return null;
}

export function memberGroupSegments(group: readonly TimelineItemView[]): MemberGroupSegment[] {
  const segments: MemberGroupSegment[] = [];
  for (const item of group) {
    const category = memberGroupCategory(item);
    const user = groupUser(item);
    if (category === null || user === null) continue;
    let segment = segments.find((candidate) => candidate.category === category);
    if (!segment) {
      segment = { category, users: [] };
      segments.push(segment);
    }
    if (!segment.users.some((known) => known.userId === user.userId)) segment.users.push(user);
  }
  return segments;
}

export type MemberGroupToken =
  | { kind: 'text'; text: string }
  | { kind: 'user'; userId: string; name: string }
  | { kind: 'others'; count: number; segment: number };

function list(locale: string, parts: readonly MemberGroupToken[][]): MemberGroupToken[] {
  const format = new Intl.ListFormat(locale, { type: 'conjunction' });
  const placeholders = parts.map((_part, index) => `${MARK}${String(index)}${MARK}`);
  const tokens: MemberGroupToken[] = [];
  for (const part of format.formatToParts(placeholders)) {
    if (part.type === 'element') tokens.push(...parts[Number(part.value.slice(1, -1))]);
    else tokens.push({ kind: 'text', text: part.value });
  }
  return tokens;
}

function segmentTokens(
  segment: MemberGroupSegment,
  index: number,
  t: Translate,
  locale: string
): MemberGroupToken[] {
  const users = segment.users;
  const shown = users.length > MAX_NAMES ? users.slice(0, SHOWN_WITH_OTHERS) : users;
  const names: MemberGroupToken[][] = shown.map((user) => [{ kind: 'user', ...user }]);
  if (shown.length < users.length) {
    names.push([{ kind: 'others', count: users.length - shown.length, segment: index }]);
  }
  const sentence = t(`timeline.memberGroup.${segment.category}`, { users: MARK });
  const at = sentence.indexOf(MARK);
  if (at === -1) return [{ kind: 'text', text: sentence }];
  return [
    { kind: 'text', text: sentence.slice(0, at) },
    ...list(locale, names),
    { kind: 'text', text: sentence.slice(at + 1) },
  ];
}

export function memberGroupSummary(
  segments: readonly MemberGroupSegment[],
  t: Translate,
  locale: string
): MemberGroupToken[] {
  return list(
    locale,
    segments.map((segment, index) => segmentTokens(segment, index, t, locale))
  ).filter((token) => token.kind !== 'text' || token.text !== '');
}
