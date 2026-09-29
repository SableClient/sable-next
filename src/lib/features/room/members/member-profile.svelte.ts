import type { PerMessageProfileView, ProfileView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

export class MemberProfile {
  open = $state(false);
  userId = $state<string | null>(null);
  anchor = $state<HTMLElement | null>(null);
  profile = $state<ProfileView | null>(null);
  pmp = $state<PerMessageProfileView | null>(null);
  failed = $state(false);
  #request = 0;

  constructor(private readonly core: Pick<CoreClient, 'userProfile'>) {}

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

  showMainAccount(): void {
    console.log('showMainAccount', this);
    if (this.userId && this.anchor) {
      void this.show(this.userId, this.anchor);
    }
  }

  async show(userId: string, anchor: HTMLElement): Promise<void> {
    const request = ++this.#request;
    this.userId = userId;
    this.anchor = anchor;
    this.open = true;
    this.profile = null;
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
