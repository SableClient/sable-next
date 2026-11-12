import { localpartOf } from '#lib/matrix-id.js';
import { createContext } from 'svelte';

export interface RoomMemberNames {
  displayName: (userId: string) => string | null;
}

export const [useRoomMemberNames, provideRoomMemberNames, hasRoomMemberNames] =
  createContext<RoomMemberNames>();

export function mentionLabel(userId: string, names: RoomMemberNames | null): string {
  const localpart = localpartOf(userId);
  return `@${names?.displayName(userId) ?? localpart}`;
}
