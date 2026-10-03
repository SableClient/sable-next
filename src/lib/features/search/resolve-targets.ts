import type { RoomSummary } from '#src/generated/protocol';

import { localHierarchyRooms } from '../room/spaces/space-hierarchy';

function rank(room: RoomSummary): number {
  return (room.state === 'joined' ? 0 : 4) + (room.is_tombstoned ? 2 : 0) + (room.is_space ? 1 : 0);
}

function best(rooms: readonly RoomSummary[]): RoomSummary | undefined {
  return rooms.reduce<RoomSummary | undefined>(
    (winner, room) => (winner === undefined || rank(room) < rank(winner) ? room : winner),
    undefined
  );
}

export function resolveRoomTarget(
  rooms: readonly RoomSummary[],
  value: string
): string | undefined {
  const wanted = value.trim().toLocaleLowerCase();
  if (wanted === '') return undefined;

  const aliased = wanted.startsWith('#') ? wanted : `#${wanted}`;

  const byIdentifier = best(
    rooms.filter(
      (room) =>
        room.room_id.toLocaleLowerCase() === wanted ||
        room.canonical_alias?.toLocaleLowerCase() === wanted ||
        room.canonical_alias?.toLocaleLowerCase() === aliased
    )
  );
  if (byIdentifier) return byIdentifier.room_id;

  const localpart = aliased.slice(1).split(':')[0];
  return best(
    rooms.filter(
      (room) =>
        room.name?.toLocaleLowerCase() === wanted ||
        room.canonical_alias?.toLocaleLowerCase().split(':')[0] === `#${localpart}`
    )
  )?.room_id;
}

export function resolveSpaceTarget(
  rooms: readonly RoomSummary[],
  value: string
): string | undefined {
  return resolveRoomTarget(
    rooms.filter((room) => room.is_space),
    value
  );
}

export function resolveSpaceRooms(
  rooms: readonly RoomSummary[],
  value: string
): string[] | undefined {
  const spaceId = resolveSpaceTarget(rooms, value);
  if (spaceId === undefined) return undefined;

  return localHierarchyRooms(rooms, spaceId)
    .filter((room) => room.room_id !== spaceId && !room.is_space)
    .map((room) => room.room_id);
}

export function resolveDirectRooms(
  rooms: readonly RoomSummary[],
  value: string
): string[] | undefined {
  const wanted = value.trim().toLocaleLowerCase();
  if (wanted === '') return undefined;
  const localpart = wanted.startsWith('@') ? wanted.slice(1) : wanted;

  const roomIds = rooms
    .filter(
      (room) =>
        room.is_direct &&
        room.direct_targets.some((userId) => {
          const folded = userId.toLocaleLowerCase();
          return folded === wanted || folded.slice(1).split(':')[0] === localpart;
        })
    )
    .map((room) => room.room_id);
  return roomIds.length > 0 ? roomIds : undefined;
}

export function parentSpaceOf(rooms: readonly RoomSummary[], roomId: string): string | undefined {
  return rooms.find(
    (room) =>
      room.is_space &&
      room.state === 'joined' &&
      room.space_children.some((child) => child.room_id === roomId)
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

export interface TargetSuggestion {
  label: string;
  value: string;
}

export function suggestRoomTarget(
  rooms: readonly RoomSummary[],
  value: string,
  spacesOnly = false
): TargetSuggestion | undefined {
  const wanted = value.trim().toLocaleLowerCase().replace(/^#/, '');
  if (wanted === '') return undefined;

  const room = best(
    rooms.filter(
      (candidate) =>
        candidate.is_space === spacesOnly &&
        (candidate.name?.toLocaleLowerCase().includes(wanted) ||
          candidate.canonical_alias?.toLocaleLowerCase().includes(wanted))
    )
  );
  if (!room) return undefined;

  const target = room.canonical_alias ?? room.room_id;
  return { label: room.name ?? target, value: target };
}

export function suggestUserTarget(
  candidates: readonly UserCandidate[],
  value: string
): TargetSuggestion | undefined {
  const wanted = value.trim().toLocaleLowerCase().replace(/^@/, '');
  if (wanted === '') return undefined;

  const candidate = candidates.find(
    (entry) =>
      entry.userId.toLocaleLowerCase().includes(wanted) ||
      entry.displayName.toLocaleLowerCase().includes(wanted)
  );
  return candidate ? { label: candidate.displayName, value: candidate.userId } : undefined;
}
