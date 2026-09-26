import QuickLRU from 'quick-lru';

import type { MemberView } from '#src/generated/protocol';

const MAX_CACHED_ROOMS = 8;

export class RoomMemberLoader {
  members = $state.raw<MemberView[]>([]);
  loading = $state(false);

  private attemptedRoomId: string | null = null;
  private generation = 0;
  private readonly cache = new QuickLRU<string, MemberView[]>({ maxSize: MAX_CACHED_ROOMS / 2 });

  reset(): void {
    this.generation += 1;
    this.members = [];
    this.loading = false;
    this.attemptedRoomId = null;
  }

  async load(
    roomId: string,
    fetchMembers: (roomId: string) => Promise<MemberView[]>
  ): Promise<void> {
    if (this.loading || this.attemptedRoomId === roomId) return;

    const generation = ++this.generation;
    this.attemptedRoomId = roomId;

    const cached = this.cache.get(roomId);
    if (cached) this.members = cached;
    else this.loading = true;

    try {
      const members = await fetchMembers(roomId);
      this.cache.set(roomId, members);
      if (generation === this.generation) this.members = members;
    } catch (error) {
      console.debug('[sable room] members unavailable', error);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  setPowerLevel(roomId: string, userId: string, level: number): void {
    if (this.attemptedRoomId !== roomId) return;
    const members = this.members.map((member) =>
      member.user_id === userId ? { ...member, power_level: level } : member
    );
    this.members = members;
    if (this.cache.has(roomId)) this.cache.set(roomId, members);
  }
}
