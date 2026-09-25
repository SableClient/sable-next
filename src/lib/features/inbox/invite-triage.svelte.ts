import { SvelteMap } from 'svelte/reactivity';

import type { InviteTriageView, RoomSummary } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { hasBadWords } from './bad-words';
import { inviter } from './inbox';

export type InviteGroup = 'known' | 'strangers' | 'spam';

export const INVITE_GROUPS: readonly InviteGroup[] = ['known', 'strangers', 'spam'];

export interface TriagedInvite {
  room: RoomSummary;
  inviter: string | null;
  reason: string | null;
  group: InviteGroup;
}

export function triageInvite(
  room: RoomSummary,
  triage: InviteTriageView | undefined,
  inviterName: (userId: string) => string
): TriagedInvite {
  const from = triage?.inviter ?? inviter(room);
  const reason = triage?.reason ?? null;
  const spam =
    triage?.inviter_banned === true ||
    hasBadWords(room.name, room.topic, from && inviterName(from), from, reason);
  return {
    room,
    inviter: from,
    reason,
    group: spam ? 'spam' : triage?.shares_room === true ? 'known' : 'strangers',
  };
}

export class InviteTriage {
  readonly #answers = new SvelteMap<string, InviteTriageView>();
  #ready = $state(false);
  #key: string | null = null;
  #generation = 0;

  constructor(private readonly core: Pick<CoreClient, 'commands'>) {}

  get ready(): boolean {
    return this.#ready;
  }

  get(roomId: string): InviteTriageView | undefined {
    return this.#answers.get(roomId);
  }

  refresh(roomIds: readonly string[]): void {
    const key = [...roomIds].sort().join('\n');
    if (key === this.#key) return;
    this.#key = key;
    const generation = ++this.#generation;
    if (roomIds.length === 0) {
      this.#answers.clear();
      this.#ready = true;
      return;
    }
    this.core.commands.inviteTriage().then(
      (invites) => {
        if (generation !== this.#generation) return;
        this.#answers.clear();
        for (const invite of invites) this.#answers.set(invite.room_id, invite);
        this.#ready = true;
      },
      (error: unknown) => {
        if (generation !== this.#generation) return;
        console.warn('[sable room] invite triage failed', error);
        this.#ready = true;
      }
    );
  }
}
