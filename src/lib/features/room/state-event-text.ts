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

export function stateEventText(item: TimelineItemView, t: Translate): string {
  const content = item.content;
  switch (content.kind) {
    case 'membership':
      return t(`timeline.membership.${content.change}`, {
        user: content.display_name ?? content.user_id,
      });
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
      return t('timeline.stateEvent', { type: content.event_type });
    }
    case 'hidden_event':
      return t('timeline.hiddenEvent', { type: content.event_type });
    case 'unsupported':
      return t('timeline.unsupported', { description: content.description });
    default:
      return t('timeline.redacted');
  }
}
