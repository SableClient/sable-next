import { copyText } from '#lib/platform/clipboard.js';
import { t } from '#lib/i18n.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { isCoreError } from '#src/transport';
import { openExternalUrl, opensExternalUrls } from '#lib/platform/external-links.js';

export function moderationErrorMessage(cause: unknown): string {
  return isCoreError(cause, 'denied')
    ? t('timeline.profileModerationDenied')
    : t('timeline.profileModerationFailed');
}

/** What a kick or ban that also deleted the member's messages did. */
export function deletedMessagesNotice(name: string, deleted: number): string {
  return deleted > 0
    ? t('timeline.moderationDeletedMessages', { name, count: deleted })
    : t('timeline.moderationDeletingMessages', { name });
}

export class MemberProfileActions {
  constructor(private readonly core: CoreClient) {}

  async copy(text: string): Promise<void> {
    try {
      await copyText(text);
    } catch (error) {
      console.debug('[sable profile] clipboard unavailable', error);
    }
  }

  async share(url: string, title: string): Promise<void> {
    try {
      await navigator.share({ url, title });
    } catch (error) {
      console.debug('[sable profile] share dismissed', error);
    }
  }

  openServer(homeserver: string): void {
    const url = `https://${homeserver}`;
    if (!opensExternalUrls()) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    void openExternalUrl(url).catch((error: unknown) => {
      console.warn('[sable profile] external link unavailable', url, error);
    });
  }

  async setIgnored(userId: string, ignored: boolean): Promise<boolean> {
    await this.core.setUserIgnored(userId, ignored);
    return ignored;
  }

  async moderate(
    roomId: string,
    userId: string,
    action: 'kick' | 'ban',
    reason: string | null,
    redactEvents = false
  ): Promise<number> {
    const params = { room_id: roomId, user_id: userId, reason, redact_events: redactEvents };
    return action === 'kick'
      ? this.core.rpc.members.kick(params)
      : this.core.rpc.members.ban(params);
  }

  async setPowerLevel(roomId: string, userId: string, level: number): Promise<void> {
    await this.core.rpc.members.setUserPowerLevel({
      room_id: roomId,
      user_id: userId,
      power_level: level,
    });
  }
}
