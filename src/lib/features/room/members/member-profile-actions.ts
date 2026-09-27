import type { CoreClient } from '#lib/core/client.svelte.js';

export class MemberProfileActions {
  constructor(private readonly core: CoreClient) {}

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
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
    window.open(`https://${homeserver}`, '_blank', 'noopener,noreferrer');
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
