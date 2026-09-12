import type { RoomSummary } from '#src/generated/protocol';

const KEY_PREFIX = 'sable.room-list.';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readRoomListSnapshot(accountId: string): RoomSummary[] | null {
  const raw = storage()?.getItem(KEY_PREFIX + accountId);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RoomSummary[]) : null;
  } catch {
    return null;
  }
}

export function writeRoomListSnapshot(accountId: string, rooms: readonly RoomSummary[]): void {
  try {
    storage()?.setItem(KEY_PREFIX + accountId, JSON.stringify(rooms));
  } catch {
    return;
  }
}

export function clearRoomListSnapshot(accountId: string): void {
  storage()?.removeItem(KEY_PREFIX + accountId);
}
