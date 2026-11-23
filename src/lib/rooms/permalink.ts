import { serverNameOf } from '#lib/matrix-id.js';
import { t } from '#lib/i18n.js';
import { copyText } from '#lib/platform/clipboard.js';
import { toasts } from '#lib/ui/toasts.svelte.js';
import { resolve } from '$app/paths';

import type { RoomListItemView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { mentionUri } from '#lib/model/model.js';
import { splitVia } from '#lib/rooms/join-address.js';
import {
  matrixLinkAction,
  matrixLinkHost,
  matrixLinkParameters,
  parseMatrixLink,
} from '#lib/rooms/matrix-link.js';

import { findRoomByPathId, roomPathParam, roomPathParamFromId } from './room-list.svelte';

let sidebarOrder: readonly string[] = [];

export function setSidebarSpaceOrder(order: readonly string[]): void {
  sidebarOrder = order;
}

function parentSpacesOf(rooms: readonly RoomListItemView[], roomId: string): RoomListItemView[] {
  return rooms.filter(
    (space) =>
      space.room_kind === 'space' &&
      space.state === 'joined' &&
      !space.is_tombstoned &&
      space.space_children.some((child) => child.room_id === roomId)
  );
}

function rootSpaceOf(
  rooms: readonly RoomListItemView[],
  roomId: string,
  spaceOrder: readonly string[]
): RoomListItemView | undefined {
  const seen = new Set<string>([roomId]);
  const roots: RoomListItemView[] = [];
  let frontier = parentSpacesOf(rooms, roomId);
  while (frontier.length > 0) {
    const next: RoomListItemView[] = [];
    for (const space of frontier) {
      if (seen.has(space.room_id)) continue;
      seen.add(space.room_id);
      const parents = parentSpacesOf(rooms, space.room_id);
      const unseen = parents.filter((parent) => !seen.has(parent.room_id));
      if (parents.length === 0) roots.push(space);
      else if (unseen.length === 0) roots.push(...parents.filter((parent) => parent !== space));
      else next.push(...unseen);
    }
    frontier = next;
  }
  const rank = (space: RoomListItemView): number => {
    const index = spaceOrder.indexOf(space.room_id);
    return index < 0 ? spaceOrder.length : index;
  };
  return roots.reduce<RoomListItemView | undefined>(
    (best, space) => (best === undefined || rank(space) < rank(best) ? space : best),
    undefined
  );
}

/** Mirrors RoomNav's sectioning, so a permalink lands where the sidebar links. */
function sectionPath(
  rooms: readonly RoomListItemView[],
  room: RoomListItemView | undefined,
  roomParam: string,
  spaceOrder: readonly string[]
): string {
  if (room?.room_kind === 'space')
    return resolve('/(app)/space/[spaceId]/lobby', { spaceId: roomParam });
  if (room?.is_direct) return resolve('/(app)/direct/[roomId]', { roomId: roomParam });

  const parentSpace = room ? rootSpaceOf(rooms, room.room_id, spaceOrder) : undefined;
  if (parentSpace) {
    return resolve('/(app)/space/[spaceId]/[roomId]', {
      spaceId: roomPathParam(parentSpace, rooms),
      roomId: roomParam,
    });
  }

  // An unknown room still resolves: the timeline reports the failure with more
  // context than a redirect to nowhere would.
  return resolve('/(app)/rooms/[roomId]', { roomId: roomParam });
}

export function roomSectionPath(
  rooms: readonly RoomListItemView[],
  roomIdOrAlias: string,
  eventId?: string | null,
  via: readonly string[] = []
): string {
  const room = findRoomByPathId(rooms, roomIdOrAlias);
  const base = sectionPath(
    rooms,
    room,
    room ? roomPathParam(room, rooms) : roomPathParamFromId(roomIdOrAlias),
    sidebarOrder
  );

  const query = new URLSearchParams();
  // A space has no timeline to focus an event in.
  if (eventId && room?.room_kind !== 'space') query.set('event', eventId);
  // `via` only helps a join, so it rides along solely for a room the client has
  // never seen. Carrying it further would pin it in the URL of a room already open.
  if (room === undefined) for (const server of via) query.append('via', server);

  const search = query.toString();
  return search === '' ? base : `${base}?${search}`;
}

const MAX_SERVERS = 3;

/** At least one server, as a room id cannot be reached without one. */
export type Route = readonly [string, ...string[]];

/** An alias resolves through its own domain; only a room id needs a route. */
export type LinkTarget = { alias: string } | { roomId: string; via: Route };

export function toRoute(servers: readonly string[]): Route | null {
  const [first, ...rest] = [...new Set(servers)].slice(0, MAX_SERVERS);
  return first ? [first, ...rest] : null;
}

/** Homeservers drop themselves from `via`, so a list naming only ours routes nowhere. */
export async function joinVia(
  core: Pick<CoreClient, 'rpc' | 'session'>,
  via: readonly string[],
  parentId: string | null
): Promise<string[]> {
  const own = core.session ? serverNameOf(core.session.user_id) : undefined;
  if (parentId === null || via.some((server) => server !== own)) return [...via];
  return [...via, ...(await core.rpc.rooms.viaServers({ room_id: parentId }))];
}

export function matrixToUrl(target: LinkTarget, eventId?: string | null): string {
  const [address, via] = 'alias' in target ? [target.alias, []] : [target.roomId, target.via];
  const path = eventId
    ? `${encodeURIComponent(address)}/${encodeURIComponent(eventId)}`
    : encodeURIComponent(address);

  // The query belongs inside the fragment, so it cannot be built with `URL`.
  const query = new URLSearchParams(via.map((server) => ['via', server])).toString();
  return `https://${matrixLinkHost()}/#/${path}${query === '' ? '' : `?${query}`}`;
}

export function matrixEventUri(roomId: string, eventId: string, via: Route): string {
  const query = new URLSearchParams(via.map((server) => ['via', server])).toString();
  const path = `roomid/${encodeURIComponent(roomId.slice(1))}/e/${encodeURIComponent(eventId.slice(1))}`;
  return `matrix:${path}?${query}`;
}

export type PermalinkFormat = 'matrix' | 'external';

function linkTo(
  target: LinkTarget,
  eventId: string | null | undefined,
  format: PermalinkFormat
): string | undefined {
  if (format === 'external') return matrixToUrl(target, eventId);
  if ('alias' in target) return mentionUri(target.alias, []);
  if (eventId) return matrixEventUri(target.roomId, eventId, target.via);
  return mentionUri(target.roomId, target.via);
}

export async function copyRoomLink(
  core: Pick<CoreClient, 'rpc' | 'session'>,
  room: Pick<RoomListItemView, 'room_id' | 'canonical_alias'>,
  eventId?: string | null,
  format: PermalinkFormat = 'external',
  hierarchy?: { via: readonly string[]; parentId: string | null }
): Promise<boolean> {
  try {
    const alias = eventId ? null : room.canonical_alias;
    let target: LinkTarget;
    if (alias) {
      target = { alias };
    } else {
      const via = toRoute(
        hierarchy
          ? await joinVia(core, hierarchy.via, hierarchy.parentId)
          : await core.rpc.rooms.viaServers({ room_id: room.room_id })
      );
      if (via === null) throw new Error('No server is known to route this room');
      target = { roomId: room.room_id, via };
    }
    const link = linkTo(target, eventId, format);
    if (link === undefined) throw new Error('Invalid Matrix room address');
    await copyText(link);
  } catch (error) {
    console.debug('[sable room] copy link failed', error);
    toasts.error(t('errors.copyFailed'));
    return false;
  }
  toasts.info(t('timeline.linkCopied'));
  return true;
}

/** A room link resolves to a route; a user link has no route of its own. */
export type PermalinkTarget = { kind: 'room'; path: string } | { kind: 'user'; userId: string };

/**
 * Resolves the tail of a `/to/...` URL, still percent-encoded so the permalink parser decodes it.
 */
export function permalinkTarget(
  rooms: readonly RoomListItemView[],
  encodedFragment: string
): PermalinkTarget | null {
  // `?via=` sits inside the fragment, where it would otherwise be parsed as
  // part of the last id.
  const { href, via } = splitVia(`https://link.sable.moe/#/${encodedFragment}`);
  const link = parseMatrixLink(href);
  if (link === null) return null;
  if (link.kind === 'user') return { kind: 'user', userId: link.user_id };

  return {
    kind: 'room',
    path: roomSectionPath(rooms, link.room_id, link.kind === 'event' ? link.event_id : null, via),
  };
}

export function matrixLinkPath(href: string): string | null {
  const link = parseMatrixLink(href);
  if (link === null) return null;
  const id = link.kind === 'user' ? link.user_id : link.room_id;
  const event = link.kind === 'event' ? `/${encodeURIComponent(link.event_id)}` : '';
  const parameters = matrixLinkParameters(href);
  const query = new URLSearchParams(
    [...parameters].filter(([key]) => key === 'via' || key.includes('.'))
  );
  const action = matrixLinkAction(href, link);
  if (action !== null) query.set('action', action);
  const search = query.toString();
  const path = resolve('/(app)/to/[...permalink]', {
    permalink: `${encodeURIComponent(id)}${event}`,
  });
  return search ? `${path}?${search}` : path;
}

export function existingChatPath(
  rooms: readonly RoomListItemView[],
  userId: string
): string | null {
  const room = rooms.find(
    (entry) =>
      entry.state === 'joined' &&
      entry.is_direct &&
      !entry.is_tombstoned &&
      entry.direct_targets.length === 1 &&
      entry.direct_targets.includes(userId)
  );
  return room ? roomSectionPath(rooms, room.room_id) : null;
}
