import type { MemberView } from '#src/generated/MemberView';

import { memberName } from './members.js';

type Translate = (key: string, params?: Record<string, unknown>) => string;

export function reactionSummary(
  senders: readonly string[],
  key: string,
  members: readonly MemberView[],
  t: Translate
): string {
  const names = senders.map((sender) => memberName(members, sender));
  const people =
    names.length === 1
      ? names[0]
      : names.length === 2
        ? t('timeline.reactionPeopleTwo', { first: names[0], second: names[1] })
        : names.length === 3
          ? t('timeline.reactionPeopleThree', {
              first: names[0],
              second: names[1],
              third: names[2],
            })
          : t('timeline.reactionPeopleMany', {
              names: names.slice(0, 3).join(', '),
              count: names.length - 3,
            });

  return t('timeline.reactedWith', { people, key });
}
