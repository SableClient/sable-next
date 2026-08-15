import type { MemberView } from '@/generated/MemberView';

export class RoomMemberLoader {
  members = $state.raw<MemberView[]>([]);
  loading = $state(false);

  private attemptedRoomId: string | null = null;
  private generation = 0;

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
    this.loading = true;
    try {
      const members = await fetchMembers(roomId);
      if (generation === this.generation) this.members = members;
    } catch (error) {
      console.debug('[sable room] members unavailable', error);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
}
