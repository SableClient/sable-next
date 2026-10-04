import type { PerMessageProfileView, ProfileView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import type { ProfileStore } from '#lib/core/profile-store.svelte.js';

export class MemberProfile {
  open = $state(false);
  userId = $state<string | null>(null);
  anchor = $state<HTMLElement | null>(null);
  profile = $state<ProfileView | null>(null);
  pmp = $state<PerMessageProfileView | null>(null);
  failed = $state(false);
  #request = 0;

  constructor(
    private readonly core: Pick<CoreClient, 'userProfile'> & {
      profiles: Pick<ProfileStore, 'peek'>;
    }
  ) {}

  close(): void {
    this.#request += 1;
    this.open = false;
    this.userId = null;
    this.anchor = null;
    this.profile = null;
    this.failed = false;
  }

  showPmp(userId: string, anchor: HTMLElement, pmp: PerMessageProfileView): void {
    this.userId = userId;
    this.anchor = anchor;
    this.open = true;
    this.failed = false;
    this.profile = null;
    this.pmp = pmp;
  }

  async show(userId: string, anchor: HTMLElement): Promise<void> {
    const request = ++this.#request;
    this.userId = userId;
    this.anchor = anchor;
    this.open = true;
    this.profile = this.core.profiles.peek(userId);
    this.pmp = null;
    this.failed = false;
    try {
      const profile = await this.core.userProfile(userId);
      if (request === this.#request) this.profile = profile;
    } catch {
      if (request === this.#request) this.failed = true;
    }
  }
}
