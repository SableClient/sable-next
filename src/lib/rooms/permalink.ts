import { resolve } from '$app/paths';

import type { RoomSummary } from '@/generated/RoomSummary';

import { parseMatrixLink } from '$lib/features/room/matrix-link';

import { findRoomByPathId, roomPathParam, roomPathParamFromId } from './room-list.svelte';

function parentSpaceOf(rooms: readonly RoomSummary[], roomId: string): RoomSummary | undefined {
  return rooms.find(
    (space) =>
      space.is_space &&
      space.state === 'joined' &&
      space.space_children.some((child) => child.room_id === roomId)
  );
}

/** Mirrors RoomNav's sectioning, so a permalink lands where the sidebar links. */
function sectionPath(
  rooms: readonly RoomSummary[],
  room: RoomSummary | undefined,
  roomParam: string
): string {
  if (room?.is_space) return resolve('/(app)/space/[spaceId]', { spaceId: roomParam });
  if (room?.is_direct) return resolve('/(app)/direct/[roomId]', { roomId: roomParam });

  const parentSpace = room ? parentSpaceOf(rooms, room.room_id) : undefined;
  if (parentSpace) {
    return resolve('/(app)/space/[spaceId]/[roomId]', {
      spaceId: roomPathParam(parentSpace),
      roomId: roomParam,
    });
  }

  // An unknown room still resolves: the timeline reports the failure with more
  // context than a redirect to nowhere would.
  return resolve('/(app)/home/[roomId]', { roomId: roomParam });
}

export function roomSectionPath(
  rooms: readonly RoomSummary[],
  roomIdOrAlias: string,
  eventId?: string | null
): string {
  const room = findRoomByPathId(rooms, roomIdOrAlias);
  const base = sectionPath(
    rooms,
    room,
    room ? roomPathParam(room) : roomPathParamFromId(roomIdOrAlias)
  );

  // A space has no timeline to focus an event in.
  if (!eventId || room?.is_space) return base;
  return `${base}?event=${encodeURIComponent(eventId)}`;
}

/**
 * Resolves the tail of a `/to/...` URL, which mirrors a matrix.to fragment.
 * Takes it still percent-encoded so the matrix.to parser decodes each segment
 * itself, as it does for a pasted link.
 */
export function permalinkPath(
  rooms: readonly RoomSummary[],
  encodedFragment: string
): string | null {
  const link = parseMatrixLink(`https://matrix.to/#/${encodedFragment}`);
  if (link === null || link.kind === 'user') return null;
  return roomSectionPath(rooms, link.roomId, link.kind === 'event' ? link.eventId : null);
}
