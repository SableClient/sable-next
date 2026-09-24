import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord } from '#lib/guards.js';

export const DISMISSED_INVITES_EVENT = 'moe.sable.dismissed_invites';

function readRoomIds(content: unknown): string[] {
  if (!isRecord(content) || !Array.isArray(content.roomIds)) return [];
  return content.roomIds.filter((roomId): roomId is string => typeof roomId === 'string');
}

class DismissedInvites {
  roomIds = $state.raw<ReadonlySet<string>>(new Set());

  private core: CoreClient | null = null;
  private generation = 0;
  private stopEvents: (() => void) | null = null;

  start(core: CoreClient): void {
    const generation = ++this.generation;
    this.core = core;
    this.stopEvents?.();
    this.stopEvents = core.subscribeEvents((event) => {
      if (event.type === 'account_data_changed' && event.event_type === DISMISSED_INVITES_EVENT) {
        void this.pull(generation);
      }
    });
    void this.pull(generation);
  }

  stop(): void {
    this.generation += 1;
    this.core = null;
    this.roomIds = new Set();
    this.stopEvents?.();
    this.stopEvents = null;
  }

  has(roomId: string): boolean {
    return this.roomIds.has(roomId);
  }

  dismiss(roomId: string): Promise<void> {
    return this.write(new Set([...this.roomIds, roomId]));
  }

  restore(roomId: string): Promise<void> {
    return this.write(new Set([...this.roomIds].filter((entry) => entry !== roomId)));
  }

  private async pull(generation: number): Promise<void> {
    try {
      const content = await this.core?.commands.accountData(DISMISSED_INVITES_EVENT);
      if (generation === this.generation) this.roomIds = new Set(readRoomIds(content));
    } catch (error) {
      console.debug('[sable room] dismissed invites unavailable', error);
    }
  }

  private async write(next: ReadonlySet<string>): Promise<void> {
    const core = this.core;
    if (core === null) return;
    const previous = this.roomIds;
    this.roomIds = next;
    try {
      await core.commands.setAccountData(DISMISSED_INVITES_EVENT, { roomIds: [...next] });
    } catch (error) {
      if (this.roomIds === next) this.roomIds = previous;
      throw error;
    }
  }
}

export const dismissedInvites = new DismissedInvites();
