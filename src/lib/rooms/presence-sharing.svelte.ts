import type {
  PresenceSharingEdit,
  PresenceSharingView,
  PresenceUserSharingView,
} from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { AccountDataSync } from '#lib/core/account-data-sync.js';

const UNSTABLE_PREFIX = 'org.continuwuity.presence_v2.msc4495.';

const PRESENCE_SHARING_EVENTS = [
  'm.presence.sharing',
  'm.presence.prompted',
  `${UNSTABLE_PREFIX}presence.sharing`,
  `${UNSTABLE_PREFIX}presence.prompted`,
];

class PresenceSharing {
  /** `null` until loaded, and while the homeserver does not support MSC4495. */
  view = $state.raw<PresenceSharingView | null>(null);
  /** Open prompts ask the core again when this changes. */
  version = $state(0);

  private readonly sync = new AccountDataSync(PRESENCE_SHARING_EVENTS, (generation) =>
    this.pull(generation)
  );

  get supported(): boolean {
    return this.view !== null;
  }

  start(core: CoreClient): void {
    this.sync.start(core);
  }

  stop(): void {
    this.sync.stop();
    this.view = null;
  }

  userSharing(userId: string): PresenceUserSharingView | null {
    const view = this.view;
    if (view === null) return null;
    if (view.allowed_users.includes(userId)) return 'allow';
    if (view.denied_users.includes(userId)) return 'deny';
    return null;
  }

  roomAllowed(roomId: string): boolean {
    return this.view?.allowed_rooms.includes(roomId) ?? false;
  }

  async edit(edit: PresenceSharingEdit): Promise<void> {
    const core = this.sync.core;
    if (core === null) return;
    const generation = this.sync.generation;
    const view = await core.rpc.account.editPresenceSharing({ edit });
    if (generation !== this.sync.generation) return;
    this.view = view;
    this.version += 1;
  }

  private async pull(generation: number): Promise<void> {
    try {
      const core = this.sync.core;
      if (core === null) return;
      const view = await core.rpc.account.presenceSharing();
      if (generation !== this.sync.generation) return;
      this.view = view;
      this.version += 1;
    } catch (error) {
      console.debug('[sable presence] presence sharing unavailable', error);
    }
  }
}

export const presenceSharing = new PresenceSharing();
