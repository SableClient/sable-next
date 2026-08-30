export const ROOM_IMAGE_PACK_EVENT_TYPE = 'm.room.image_pack';
export const ROOM_EMOTES_EVENT_TYPE = 'im.ponies.room_emotes';
export const USER_EMOTES_EVENT_TYPE = 'im.ponies.user_emotes';
export const IMAGE_PACK_ROOMS_EVENT_TYPE = 'm.image_pack.rooms';
export const EMOTE_ROOMS_EVENT_TYPE = 'im.ponies.emote_rooms';

export interface PackAddress {
  roomId: string;
  stateKey: string;
}

export function packAddressEqual(left?: PackAddress, right?: PackAddress): boolean {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.roomId === right.roomId && left.stateKey === right.stateKey;
}

export function packAddressKey(address: PackAddress): string {
  return `${address.roomId}/${address.stateKey}`;
}
