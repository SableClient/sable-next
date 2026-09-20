import { createContext } from 'svelte';

export interface RoomMemberNames {
  displayName: (userId: string) => string | null;
}

export const [useRoomMemberNames, provideRoomMemberNames, hasRoomMemberNames] =
  createContext<RoomMemberNames>();

export function mentionLabel(userId: string, names: RoomMemberNames | null): string {
  const localpart = userId.replace(/^@/, '').split(':')[0];
  return `@${names?.displayName(userId) ?? localpart}`;
}
