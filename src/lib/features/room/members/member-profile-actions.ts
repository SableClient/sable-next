import { copyText } from '#lib/platform/clipboard.js';
import { t } from '#lib/i18n.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { CoreError } from '#src/transport';
import { openExternalUrl, opensExternalUrls } from '#lib/platform/external-links.js';

export function moderationErrorMessage(cause: unknown): string {
  return cause instanceof CoreError && cause.detail.code === 'denied'
    ? t('timeline.profileModerationDenied')
    : t('timeline.profileModerationFailed');
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
    reason: string | null
  ): Promise<void> {
    if (action === 'kick') await this.core.commands.kickUser(roomId, userId, reason);
    else await this.core.commands.banUser(roomId, userId, reason);
  }

  async setPowerLevel(roomId: string, userId: string, level: number): Promise<void> {
    await this.core.commands.setUserPowerLevel(roomId, userId, level);
  }
}
