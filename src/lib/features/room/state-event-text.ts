import type { StateChangeView } from '#src/generated/StateChangeView';
import type { TimelineItemView } from '#src/generated/TimelineItemView';

export type Translate = (key: string, values?: Record<string, unknown>) => string;

function stateChangeText(change: StateChangeView, user: string, t: Translate): string {
  switch (change.kind) {
    case 'room_name': {
      if (change.name === null) return t('timeline.roomNameRemoved', { user });
      const key = change.previous === null ? 'roomNameSet' : 'roomNameChanged';
      return t(`timeline.${key}`, { user, name: change.name });
    }
    case 'room_topic':
      return change.topic === null
        ? t('timeline.roomTopicRemoved', { user })
        : t('timeline.roomTopicChanged', { user, topic: change.topic });
    case 'room_avatar':
      return change.removed
        ? t('timeline.roomAvatarRemoved', { user })
        : t('timeline.roomAvatarChanged', { user });
    case 'pinned_events': {
      if (change.added.length > 0 && change.removed.length === 0) {
        return t('timeline.pinnedAdded', { user, count: change.added.length });
      }
      if (change.removed.length > 0 && change.added.length === 0) {
        return t('timeline.pinnedRemoved', { user, count: change.removed.length });
      }
      return t('timeline.pinnedChanged', { user, count: change.total });
    }
    case 'call_membership':
      return change.joined ? t('timeline.callJoined', { user }) : t('timeline.callLeft', { user });
  }
}

const MODERATED: ReadonlySet<string> = new Set([
  'banned',
  'unbanned',
  'kicked',
  'invited',
  'kicked_and_banned',
  'invitation_revoked',
  'knock_accepted',
  'knock_denied',
]);

function membershipText(
  content: Extract<TimelineItemView['content'], { kind: 'membership' }>,
  item: TimelineItemView,
  t: Translate
): string {
  const user = content.display_name ?? content.user_id;
  const actor = item.sender_name ?? item.sender;
  const attributed =
    MODERATED.has(content.change) && actor !== null && item.sender !== content.user_id;

  const text = attributed
    ? t(`timeline.membershipBy.${content.change}`, { user, actor })
    : t(`timeline.membership.${content.change}`, { user });

  const reason = content.reason;
  return reason ? t('timeline.withReason', { text, reason }) : text;
}

export function stateEventText(item: TimelineItemView, t: Translate): string {
  const content = item.content;
  switch (content.kind) {
    case 'membership':
      return membershipText(content, item, t);
    case 'profile_change': {
      const user = content.display_name?.old ?? content.user_id;
      if (content.display_name?.new) {
        const key = content.display_name.old ? 'profileNameChanged' : 'profileNameSet';
        return t(`timeline.${key}`, { user, name: content.display_name.new });
      }
      if (content.display_name) return t('timeline.profileNameRemoved', { user });
      return t('timeline.profileAvatarChanged', { user });
    }
    case 'state_event': {
      const user = item.sender_name ?? item.sender ?? t('timeline.unknownSender');
      if (content.change) return stateChangeText(content.change, user, t);
      return t('timeline.stateEvent', { user, type: content.event_type });
    }
    case 'hidden_event':
      return t('timeline.hiddenEvent', { type: content.event_type });
    case 'unsupported':
      return t('timeline.unsupported', { description: content.description });
    default:
      return t('timeline.redacted');
  }
}

const SUBJECT_MARKER = '\u0000';

export function stateEventSubject(
  item: TimelineItemView,
  t: Translate
): { userId: string; name: string; before: string; after: string } | null {
  const content = item.content;
  let userId: string | null;
  let name: string | null;
  switch (content.kind) {
    case 'membership':
      userId = content.user_id;
      name = content.display_name ?? content.user_id;
      break;
    case 'profile_change':
      userId = content.user_id;
      name = content.display_name?.old ?? content.user_id;
      break;
    case 'state_event':
      if (content.change === null) return null;
      userId = item.sender;
      name = item.sender_name ?? item.sender;
      break;
    default:
      return null;
  }
  if (!userId || !name) return null;

  const text = stateEventText(item, (key, values) =>
    values && 'user' in values ? t(key, { ...values, user: SUBJECT_MARKER }) : t(key, values)
  );
  const at = text.indexOf(SUBJECT_MARKER);
  if (at === -1) return null;
  return { userId, name, before: text.slice(0, at), after: text.slice(at + 1) };
}
