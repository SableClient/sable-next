import type { ProfileView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

export class TimelineItemProfiles {
  sender = $state<ProfileView | null>(null);
  reply = $state<ProfileView | null>(null);

  #senderId: string | null = null;
  #replyId: string | null = null;
  #senderGeneration = 0;
  #replyGeneration = 0;
  #senderPreview = false;
  #replyPreview = false;

  constructor(private readonly core: CoreClient) {}

  sync(senderId: string | null, replyId: string | null, preview: boolean): void {
    this.#syncSender(senderId, preview);
    this.#syncReply(replyId, preview);
  }

  dispose(): void {
    this.#senderGeneration += 1;
    this.#replyGeneration += 1;
    this.#senderId = null;
    this.#replyId = null;
  }

  #syncSender(userId: string | null, preview: boolean): void {
    if (this.#senderId === userId && this.#senderPreview === preview) return;
    this.#senderId = userId;
    this.#senderPreview = preview;
    const generation = ++this.#senderGeneration;
    this.sender = null;
    if (userId === null || preview) return;
    void this.core.userProfile(userId).then(
      (profile) => {
        if (generation === this.#senderGeneration) this.sender = profile;
      },
      () => {}
    );
  }

  #syncReply(userId: string | null, preview: boolean): void {
    if (this.#replyId === userId && this.#replyPreview === preview) return;
    this.#replyId = userId;
    this.#replyPreview = preview;
    const generation = ++this.#replyGeneration;
    this.reply = null;
    if (userId === null || preview) return;
    void this.core.userProfile(userId).then(
      (profile) => {
        if (generation === this.#replyGeneration) this.reply = profile;
      },
      () => {}
    );
  }
}
