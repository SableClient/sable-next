import type { PackAddressView } from '#src/generated/protocol';

export const ROOM_IMAGE_PACK_EVENT_TYPE = 'm.room.image_pack';

export type PackAddress = PackAddressView;

export function packAddressEqual(left?: PackAddress, right?: PackAddress): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.room_id === right.room_id && left.state_key === right.state_key;
}

export function packAddressKey(address: PackAddress): string {
  return `${address.room_id}/${address.state_key}`;
}
