import { readText, writeText } from '#lib/platform/local-json.js';

const KEY_PREFIX = 'sable-last-room:';

export function lastRoomId(accountId: string): string | null {
  return readText(KEY_PREFIX + accountId);
}

export function rememberLastRoom(accountId: string, roomId: string): void {
  writeText(KEY_PREFIX + accountId, roomId);
}
