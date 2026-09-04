import { resolve } from '$app/paths';

import type { RoomSummary } from '#src/generated/RoomSummary';

import { splitVia } from '#lib/features/room/join-address.js';
import { parseMatrixLink } from '#lib/features/room/matrix-link.js';

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
  return resolve('/(app)/rooms/[roomId]', { roomId: roomParam });
}

export function roomSectionPath(
  rooms: readonly RoomSummary[],
  roomIdOrAlias: string,
  eventId?: string | null,
  via: readonly string[] = []
): string {
  const room = findRoomByPathId(rooms, roomIdOrAlias);
  const base = sectionPath(
    rooms,
    room,
    room ? roomPathParam(room) : roomPathParamFromId(roomIdOrAlias)
  );

  const query = new URLSearchParams();
  // A space has no timeline to focus an event in.
  if (eventId && !room?.is_space) query.set('event', eventId);
  // `via` only helps a join, so it rides along solely for a room the client has
  // never seen. Carrying it further would pin it in the URL of a room already open.
  if (room === undefined) for (const server of via) query.append('via', server);

  const search = query.toString();
  return search === '' ? base : `${base}?${search}`;
}

/** An alias resolves through its own domain; only a room id needs routing help. */
export function viaFor(address: string, via: readonly string[]): string[] {
  return address.startsWith('#') ? [] : [...via];
}

/**
 * A matrix.to link others can follow. A room id is not routable without `via`,
 * which is why it is not optional for that form.
 */
export function matrixToUrl(
  address: string,
  via: readonly string[],
  eventId?: string | null
): string {
  const path = eventId
    ? `${encodeURIComponent(address)}/${encodeURIComponent(eventId)}`
    : encodeURIComponent(address);

  // The query belongs inside the fragment, so it cannot be built with `URL`.
  const query = new URLSearchParams(
    viaFor(address, via).map((server) => ['via', server])
  ).toString();
  return `https://matrix.to/#/${path}${query === '' ? '' : `?${query}`}`;
}

/** A room link resolves to a route; a user link has no route of its own. */
export type PermalinkTarget = { kind: 'room'; path: string } | { kind: 'user'; userId: string };

/**
 * Resolves the tail of a `/to/...` URL, which mirrors a matrix.to fragment.
 * Takes it still percent-encoded so the matrix.to parser decodes each segment
 * itself, as it does for a pasted link.
 */
export function permalinkTarget(
  rooms: readonly RoomSummary[],
  encodedFragment: string
): PermalinkTarget | null {
  // `?via=` sits inside the fragment, where it would otherwise be parsed as
  // part of the last id.
  const { href, via } = splitVia(`https://matrix.to/#/${encodedFragment}`);
  const link = parseMatrixLink(href);
  if (link === null) return null;
  if (link.kind === 'user') return { kind: 'user', userId: link.userId };

  return {
    kind: 'room',
    path: roomSectionPath(rooms, link.roomId, link.kind === 'event' ? link.eventId : null, via),
  };
}
