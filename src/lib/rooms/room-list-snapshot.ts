import type { RoomBadgeView, RoomListItemView, RoomSectionView } from '#src/generated/protocol';

const KEY_PREFIX = 'sable.room-list.v2.';
const LEGACY_KEY_PREFIX = 'sable.room-list.';

export interface RoomListSnapshot {
  rooms: RoomListItemView[];
  sections: RoomSectionView[];
  badges: RoomBadgeView[];
  quiet_rooms: string[];
}

function storage(): Storage | null {
  if (import.meta.env.VITE_SABLE_SERVER_URL) return null;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A snapshot from a build before the core resolved counts paints nothing. */
function isCurrentSummary(room: unknown): boolean {
  return typeof room === 'object' && room !== null && 'counts' in room;
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
