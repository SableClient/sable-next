import type { MemberView } from '#src/generated/MemberView';

const MAX_CACHED_ROOMS = 8;

export class RoomMemberLoader {
  members = $state.raw<MemberView[]>([]);
  loading = $state(false);

  private attemptedRoomId: string | null = null;
  private generation = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private readonly cache = new Map<string, MemberView[]>();

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
      this.remember(roomId, members);
      if (generation === this.generation) this.members = members;
    } catch (error) {
      console.debug('[sable room] members unavailable', error);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }

  private remember(roomId: string, members: MemberView[]): void {
    this.cache.delete(roomId);
    this.cache.set(roomId, members);
    while (this.cache.size > MAX_CACHED_ROOMS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }
}
