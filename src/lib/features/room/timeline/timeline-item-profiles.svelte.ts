import type { ProfileView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

const RETRY_DELAYS_MS = [3000, 10_000, 30_000];
const FIRST_LOOKUP_DELAY_MS = 300;

class ProfileSlot {
  profile = $state<ProfileView | null>(null);

  #userId: string | null = null;
  #preview = false;
  #generation = 0;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #lookup: AbortController | null = null;

  constructor(private readonly core: CoreClient) {}

  sync(userId: string | null, preview: boolean): void {
    if (this.#userId === userId && this.#preview === preview) return;
    this.#userId = userId;
    this.#preview = preview;
    this.profile = null;
    this.#load(0);
  }

  refresh(userId: string): void {
    if (userId === this.#userId) this.#load(0);
  }

  dispose(): void {
    this.#userId = null;
    this.#load(0);
  }

  #load(attempt: number): void {
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    this.#lookup?.abort();
    this.#lookup = null;
    const generation = ++this.#generation;
    const userId = this.#userId;
    if (userId === null || this.#preview) return;
    if (attempt === 0) {
      const cached = this.core.cachedUserProfile(userId);
      if (cached !== null) {
        this.profile = cached;
        return;
      }
      this.#retry = setTimeout(() => {
        this.#fetch(userId, generation, attempt);
      }, FIRST_LOOKUP_DELAY_MS);
      return;
    }
    this.core.forgetProfileFailure(userId);
    this.#fetch(userId, generation, attempt);
  }

  #fetch(userId: string, generation: number, attempt: number): void {
    this.#retry = null;
    const lookup = new AbortController();
    this.#lookup = lookup;
    void this.core.userProfile(userId, false, lookup.signal).then(
      (profile) => {
        if (generation === this.#generation) this.profile = profile;
      },
      () => {
        if (generation !== this.#generation || attempt >= RETRY_DELAYS_MS.length) return;
        this.#retry = setTimeout(() => {
          this.#load(attempt + 1);
        }, RETRY_DELAYS_MS[attempt]);
      }
    );
  }
}

export class TimelineItemProfiles {
  readonly #sender: ProfileSlot;
  readonly #reply: ProfileSlot;
  readonly #unsubscribe: () => void;

  constructor(core: CoreClient) {
    this.#sender = new ProfileSlot(core);
    this.#reply = new ProfileSlot(core);
    this.#unsubscribe = core.onProfileChanged((userId) => {
      this.#sender.refresh(userId);
      this.#reply.refresh(userId);
    });
  }

  get sender(): ProfileView | null {
    return this.#sender.profile;
  }

  get reply(): ProfileView | null {
    return this.#reply.profile;
  }

  sync(senderId: string | null, replyId: string | null, preview: boolean): void {
    this.#sender.sync(senderId, preview);
    this.#reply.sync(replyId, preview);
  }

  dispose(): void {
    this.#unsubscribe();
    this.#sender.dispose();
    this.#reply.dispose();
  }
}
