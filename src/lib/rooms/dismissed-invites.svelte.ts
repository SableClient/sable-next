import type { CoreClient } from '#lib/core/client.svelte.js';

export const DISMISSED_INVITES_EVENT = 'moe.sable.dismissed_invites';

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
    return this.write(roomId, true);
  }

  restore(roomId: string): Promise<void> {
    return this.write(roomId, false);
  }

  private async pull(generation: number): Promise<void> {
    try {
      const core = this.core;
      if (core === null) return;
      const roomIds = await core.commands.dismissedInvites();
      if (generation === this.generation) this.roomIds = new Set(roomIds);
    } catch (error) {
      console.debug('[sable room] dismissed invites unavailable', error);
    }
  }

  private async write(roomId: string, dismissed: boolean): Promise<void> {
    const core = this.core;
    if (core === null) return;
    const generation = this.generation;
    const previous = this.roomIds;
    const next = dismissed
      ? new Set([...previous, roomId])
      : new Set([...previous].filter((entry) => entry !== roomId));
    this.roomIds = next;
    try {
      const stored = await core.commands.setInviteDismissed(roomId, dismissed);
      if (generation === this.generation) this.roomIds = new Set(stored);
    } catch (error) {
      if (this.roomIds === next) this.roomIds = previous;
      throw error;
    }
  }
}

export const dismissedInvites = new DismissedInvites();
