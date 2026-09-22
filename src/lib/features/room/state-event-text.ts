import type { StateChangeView, TimelineItemView } from '#src/generated/protocol';

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
      if (change.added.length > 0 && change.removed.length > 0) {
        return t('timeline.pinnedBoth', {
          user,
          added: t('timeline.pinnedAddedPart', { count: change.added.length }),
          removed: t('timeline.pinnedRemovedPart', { count: change.removed.length }),
        });
      }
      if (change.added.length > 0) {
        return t('timeline.pinnedAdded', { user, count: change.added.length });
      }
      if (change.removed.length > 0) {
        return t('timeline.pinnedRemoved', { user, count: change.removed.length });
      }
      return t('timeline.pinnedUnchanged', { user });
    }
    case 'call_membership':
      return change.joined ? t('timeline.callJoined', { user }) : t('timeline.callLeft', { user });
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function reactionKey(content: unknown): string | null {
  const body = record(content);
  if (!body) return null;
  const shortcode = text(body.shortcode) ?? text(body['com.beeper.reaction.shortcode']);
  if (shortcode) return `:${shortcode}:`;
  return text(record(body['m.relates_to'])?.key);
}

function hiddenEventText(
  content: Extract<TimelineItemView['content'], { kind: 'hidden_event' }>,
  user: string,
  t: Translate
): string {
  if (content.event_type === 'm.reaction') {
    const key = reactionKey(content.content);
    if (key) return t('timeline.hiddenReaction', { user, key });
  }
  if (content.event_type === 'm.room.redaction') return t('timeline.hiddenRedaction', { user });
  return t('timeline.hiddenEvent', { user, type: content.event_type });
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
    case 'call_invite':
      return t('timeline.callInvite', {
        user: item.sender_name ?? item.sender ?? t('timeline.unknownSender'),
      });
    case 'malformed':
      return t('timeline.malformedEvent', { type: content.event_type });
    case 'membership':
      return membershipText(content, item, t);
    case 'profile_change': {
      const user = content.display_name?.old ?? content.user_id;
      if (content.display_name?.new) {
        const key = content.display_name.old ? 'profileNameChanged' : 'profileNameSet';
        return t(`timeline.${key}`, { user, name: content.display_name.new });
      }
      if (content.display_name) return t('timeline.profileNameRemoved', { user });
      return content.avatar && content.avatar.new === null
        ? t('timeline.profileAvatarRemoved', { user })
        : t('timeline.profileAvatarChanged', { user });
    }
    case 'state_event': {
      const user = item.sender_name ?? item.sender ?? t('timeline.unknownSender');
      if (content.change) return stateChangeText(content.change, user, t);
      return t('timeline.hiddenStateEvent', { user, type: content.event_type });
    }
    case 'hidden_event':
      return hiddenEventText(
        content,
        item.sender_name ?? item.sender ?? t('timeline.unknownSender'),
        t
      );
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
