import type { RoomBadgeView, RoomListItemView, RoomSectionView } from '#src/generated/protocol';

const KEY_PREFIX = 'sable.room-list.v2.';
const LEGACY_KEY_PREFIX = 'sable.room-list.';

export interface RoomListSnapshot {
  rooms: RoomListItemView[];
  sections: RoomSectionView[];
  badges: RoomBadgeView[];
  quiet_rooms: string[];
  app_badge?: number;
}

function storage(): Storage | null {
  if (import.meta.env.VITE_SABLE_SERVER_URL) return null;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * A snapshot from a build before the core resolved counts, placed preview
 * emotes or listed group members paints nothing.
 */
function isCurrentSummary(room: unknown): boolean {
  if (typeof room !== 'object' || room === null) return false;
  if (!('counts' in room) || !('group_members' in room)) return false;
  const latest = (room as { latest_event?: unknown }).latest_event;
  if (typeof latest !== 'object' || latest === null) return true;
  const { emotes } = latest as { emotes?: unknown };
  return (
    Array.isArray(emotes) &&
    emotes.every(
      (emote: unknown) => typeof emote === 'object' && emote !== null && 'offset' in emote
    )
  );
}

function isSnapshot(value: unknown): value is RoomListSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const { rooms, sections, badges, quiet_rooms } = value as Partial<RoomListSnapshot>;
  return (
    Array.isArray(rooms) &&
    rooms.every(isCurrentSummary) &&
    Array.isArray(sections) &&
    Array.isArray(badges) &&
    Array.isArray(quiet_rooms)
  );
}

export function readRoomListSnapshot(accountId: string): RoomListSnapshot | null {
  const raw = storage()?.getItem(KEY_PREFIX + accountId);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRoomListSnapshot(accountId: string, snapshot: RoomListSnapshot): void {
  try {
    storage()?.removeItem(LEGACY_KEY_PREFIX + accountId);
    storage()?.setItem(KEY_PREFIX + accountId, JSON.stringify(snapshot));
  } catch {
    return;
  }
}

export function clearRoomListSnapshot(accountId: string): void {
  storage()?.removeItem(LEGACY_KEY_PREFIX + accountId);
  storage()?.removeItem(KEY_PREFIX + accountId);
}
