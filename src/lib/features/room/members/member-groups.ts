import type { TimelineSegmentView } from '#src/generated/protocol';

import type { Translate } from '../timeline/state-event-text';

const MAX_NAMES = 3;
const SHOWN_WITH_OTHERS = 2;
const MARK = '\u0000';

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
  segment: TimelineSegmentView,
  index: number,
  t: Translate,
  locale: string
): MemberGroupToken[] {
  const users = segment.users;
  const shown = users.length > MAX_NAMES ? users.slice(0, SHOWN_WITH_OTHERS) : users;
  const names: MemberGroupToken[][] = shown.map((user) => [
    { kind: 'user', userId: user.user_id, name: user.name },
  ]);
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
  segments: readonly TimelineSegmentView[],
  t: Translate,
  locale: string
): MemberGroupToken[] {
  return list(
    locale,
    segments.map((segment, index) => segmentTokens(segment, index, t, locale))
  ).filter((token) => token.kind !== 'text' || token.text !== '');
}
