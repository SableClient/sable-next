import type { MemberView } from '@/generated/MemberView';

export class RoomMemberLoader {
  members = $state.raw<MemberView[]>([]);
  loading = $state(false);

  private loadedRoomId: string | null = null;
  private generation = 0;

  reset(): void {
    this.generation += 1;
    this.members = [];
    this.loading = false;
    this.loadedRoomId = null;
  }

  async load(
    roomId: string,
    fetchMembers: (roomId: string) => Promise<MemberView[]>
  ): Promise<void> {
    if (this.loading || this.loadedRoomId === roomId) return;

    const generation = ++this.generation;
    this.loading = true;
    try {
      const members = await fetchMembers(roomId);
      if (generation === this.generation) {
        this.members = members;
        this.loadedRoomId = roomId;
      }
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
}
