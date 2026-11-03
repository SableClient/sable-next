import type { PowerLevelTagView } from '#src/generated/protocol';
import { INITIAL_MEMBER_ROWS, limitGroups, type MemberGroup } from './member-listing.js';

export interface MemberPreview {
  key: string;
  threshold: number;
  count: number;
  groups: (MemberGroup & { tag: PowerLevelTagView })[];
}

export class MemberPreviews {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- only clearing invalidates a displayed preview
  private rooms = new Map<string, MemberPreview>();
  private revision = $state(0);

  get(roomId: string, key: string, threshold: number | null): MemberPreview | null {
    void this.revision;
    const preview = this.rooms.get(roomId);
    return preview?.key === key && (threshold === null || preview.threshold === threshold)
      ? preview
      : null;
  }

  set(roomId: string, preview: MemberPreview): void {
    this.rooms.delete(roomId);
    this.rooms.set(roomId, {
      ...preview,
      groups: limitGroups(preview.groups, INITIAL_MEMBER_ROWS),
    });
    const oldest = this.rooms.keys().next().value;
    if (this.rooms.size > 8 && oldest !== undefined) this.rooms.delete(oldest);
  }

  clear(): void {
    this.rooms.clear();
    this.revision += 1;
  }
}
