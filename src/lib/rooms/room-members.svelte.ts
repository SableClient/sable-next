import type { MemberView } from '#src/generated/protocol';
import { sleep } from '#lib/sleep.js';

export const MEMBER_RETRY_DELAYS_MS = [2000, 5000, 15_000];

export class RoomMemberLoader {
  members = $state.raw<MemberView[]>([]);
  loading = $state(false);

  roomId = $state<string | null>(null);
  private generation = 0;
  private refreshingGeneration: number | null = null;
  private refreshRequests = 0;

  reset(): void {
    this.generation += 1;
    this.members = [];
    this.loading = false;
    this.roomId = null;
  }

  async load(
    roomId: string,
    fetchMembers: (roomId: string) => Promise<MemberView[]>
  ): Promise<void> {
    if (this.loading || this.roomId === roomId) return;

    const generation = ++this.generation;
    this.roomId = roomId;

    this.loading = true;

    try {
      for (let attempt = 0; ; attempt += 1) {
        const last = attempt >= MEMBER_RETRY_DELAYS_MS.length;
        try {
          const members = await fetchMembers(roomId);
          if (generation !== this.generation) return;
          if (members.length > 0 || last) {
            this.members = members;
            return;
          }
        } catch (error) {
          console.debug('[sable room] members unavailable', error);
          if (last) return;
        }
        await sleep(MEMBER_RETRY_DELAYS_MS[attempt]);
        if (generation !== this.generation) return;
      }
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  async refresh(
    roomId: string,
    fetchMembers: (roomId: string) => Promise<MemberView[]>
  ): Promise<void> {
    if (this.roomId !== roomId) return;
    const generation = this.generation;
    if (this.refreshingGeneration === generation) {
      this.refreshRequests += 1;
      return;
    }
    this.refreshingGeneration = generation;
    try {
      let seen: number;
      do {
        seen = this.refreshRequests;
        try {
          const members = await fetchMembers(roomId);
          if (generation === this.generation) this.members = members;
        } catch (error) {
          console.debug('[sable room] members unavailable', error);
        }
      } while (seen !== this.refreshRequests && generation === this.generation);
    } finally {
      if (this.refreshingGeneration === generation) this.refreshingGeneration = null;
    }
  }

  upsert(roomId: string, member: MemberView): void {
    if (this.roomId !== roomId) return;
    const at = this.members.findIndex((known) => known.user_id === member.user_id);
    this.members =
      at === -1
        ? [...this.members, member]
        : this.members.map((known, index) => (index === at ? member : known));
  }

  setPowerLevel(roomId: string, userId: string, level: number): void {
    if (this.roomId !== roomId) return;
    this.members = this.members.map((member) =>
      member.user_id === userId ? { ...member, power_level: level } : member
    );
  }
}
