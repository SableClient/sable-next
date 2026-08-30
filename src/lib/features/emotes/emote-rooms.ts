import type { PackAddress } from './pack-address.js';
import { packAddressEqual } from './pack-address.js';

export type EmoteRoomsContent = Record<string, Record<string, Record<string, never>>>;

export function readEmoteRooms(content: unknown): EmoteRoomsContent {
  if (typeof content !== 'object' || content === null) return {};

  const rooms = (content as { rooms?: unknown }).rooms;
  if (typeof rooms !== 'object' || rooms === null) return {};

  const selection: EmoteRoomsContent = {};
  for (const [roomId, packs] of Object.entries(rooms as Record<string, unknown>)) {
    if (typeof packs !== 'object' || packs === null) continue;
    selection[roomId] = Object.fromEntries(
      Object.keys(packs as Record<string, unknown>).map((stateKey) => [stateKey, {}])
    );
  }
  return selection;
}

export function emoteRoomsEventContent(selection: EmoteRoomsContent): Record<string, unknown> {
  return { rooms: selection };
}

export function selectedAddresses(selection: EmoteRoomsContent): PackAddress[] {
  return Object.entries(selection).flatMap(([roomId, packs]) =>
    Object.keys(packs).map((stateKey) => ({ roomId, stateKey }))
  );
}

export function withSelection(
  selection: EmoteRoomsContent,
  added: readonly PackAddress[],
  removed: readonly PackAddress[]
): EmoteRoomsContent {
  const kept = selectedAddresses(selection)
    .concat(added)
    .filter(
      (address, index, all) =>
        all.findIndex((other) => packAddressEqual(other, address)) === index &&
        !removed.some((gone) => packAddressEqual(gone, address))
    );

  const next: EmoteRoomsContent = {};
  for (const address of kept) {
    next[address.roomId] = { ...next[address.roomId], [address.stateKey]: {} };
  }
  return next;
}
