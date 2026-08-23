import type { RoomSummary } from '#src/generated/RoomSummary';

export function resolveRoomTarget(
  rooms: readonly RoomSummary[],
  value: string
): string | undefined {
  const wanted = value.trim().toLocaleLowerCase();
  if (wanted === '') return undefined;

  const aliased = wanted.startsWith('#') ? wanted : `#${wanted}`;

  const byIdentifier = rooms.find(
    (room) =>
      room.room_id.toLocaleLowerCase() === wanted ||
      room.canonical_alias?.toLocaleLowerCase() === wanted ||
      room.canonical_alias?.toLocaleLowerCase() === aliased
  );
  if (byIdentifier) return byIdentifier.room_id;

  const localpart = aliased.slice(1).split(':')[0];
  return rooms.find(
    (room) =>
      room.name?.toLocaleLowerCase() === wanted ||
      room.canonical_alias?.toLocaleLowerCase().split(':')[0] === `#${localpart}`
  )?.room_id;
}

export interface UserCandidate {
  userId: string;
  displayName: string;
}

export function resolveUserTarget(
  candidates: readonly UserCandidate[],
  value: string
): string | undefined {
  const wanted = value.trim();
  if (wanted === '') return undefined;
  if (wanted.startsWith('@') && wanted.includes(':')) return wanted;

  const folded = wanted.toLocaleLowerCase();
  const localpart = folded.startsWith('@') ? folded.slice(1) : folded;

  return candidates.find(
    (candidate) =>
      candidate.userId.toLocaleLowerCase() === folded ||
      candidate.userId.toLocaleLowerCase().slice(1).split(':')[0] === localpart ||
      candidate.displayName.toLocaleLowerCase() === folded
  )?.userId;
}
