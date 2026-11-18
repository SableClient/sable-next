import type { CoreClient } from '#lib/core/client.svelte.js';
import { i18n } from '#lib/i18n.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

export class MemberProfileSource {
  open = $state(false);
  title = $state('');
  text = $state('');

  constructor(private readonly core: Pick<CoreClient, 'rpc'>) {}

  async viewProfile(userId: string): Promise<void> {
    try {
      this.text = await this.core.rpc.account.userProfileSource({ user_id: userId });
      this.title = i18n.t('timeline.profileSourceTitle');
      this.open = true;
    } catch (error) {
      console.warn('[sable profile] loading profile source failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    }
  }

  async viewMemberEvent(roomId: string, userId: string): Promise<void> {
    try {
      const content = await this.core.rpc.room_state.event({
        room_id: roomId,
        event_type: 'm.room.member',
        state_key: userId,
      });
      if (content === null || content === undefined) {
        toasts.info(i18n.t('room.devMissing'));
        return;
      }
      this.text = JSON.stringify(content, null, 2);
      this.title = i18n.t('timeline.profileMemberEventTitle');
      this.open = true;
    } catch (error) {
      console.warn('[sable profile] loading member event failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    }
  }
}
