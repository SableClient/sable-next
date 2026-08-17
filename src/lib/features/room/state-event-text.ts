import type { TimelineItemView } from '@/generated/TimelineItemView';

export type Translate = (key: string, values?: Record<string, unknown>) => string;

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
    case 'state_event':
      return t('timeline.stateEvent', { type: content.event_type });
    case 'hidden_event':
      return t('timeline.hiddenEvent', { type: content.event_type });
    case 'unsupported':
      return t('timeline.unsupported', { description: content.description });
    default:
      return t('timeline.redacted');
  }
}
