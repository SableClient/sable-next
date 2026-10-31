import { resolve } from '$app/paths';

import type { Rpc } from '#src/generated/protocol';

import { joinRoom } from '#lib/core/api/rooms.js';
import { isBanned } from '#lib/rooms/join-errors.js';
import { roomPathParamFromId } from '#lib/rooms/room-list.svelte.js';

export type JoinOrKnock =
  | { kind: 'joined'; roomId: string }
  | { kind: 'knock'; address: string; via: string[] };

/**
 * A `knock` room refuses a plain join (403), so when joining fails and the room
 * can be knocked on, the caller is told to offer that instead of an error.
 * Any other failure is rethrown unchanged.
 */
export async function joinOrOfferKnock(
  rpc: Pick<Rpc, 'rooms'>,
  address: string,
  via: readonly string[] = []
): Promise<JoinOrKnock> {
  try {
    return { kind: 'joined', roomId: await joinRoom(rpc, address, via) };
  } catch (joinError) {
    if (isBanned(joinError)) throw joinError;
    const preview = await rpc.rooms.preview({ address, via: [...via] }).catch((error: unknown) => {
      console.debug('[sable room] preview unavailable', error);
      return null;
    });
    if (preview?.join_rule === 'knock' || preview?.join_rule === 'knock_restricted') {
      return { kind: 'knock', address, via: [...via] };
    }
    throw joinError;
  }
}

/** The room page shows the "ask to join" screen for a room that is not joined. */
export function knockPagePath(address: string, via: readonly string[]): string {
  const path = resolve('/(app)/rooms/[roomId]', { roomId: roomPathParamFromId(address) });
  const query = new URLSearchParams(via.map((server) => ['via', server])).toString();
  return query === '' ? path : `${path}?${query}`;
}

export function joinOrKnockPath(result: JoinOrKnock): string {
  return result.kind === 'knock'
    ? knockPagePath(result.address, result.via)
    : resolve('/(app)/rooms/[roomId]', { roomId: roomPathParamFromId(result.roomId) });
}
