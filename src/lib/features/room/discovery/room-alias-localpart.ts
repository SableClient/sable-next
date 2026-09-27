export type RoomAliasLocalpartError = 'empty' | 'colon' | 'whitespace' | 'control';

function hasControlCharacter(localpart: string): boolean {
  for (let index = 0; index < localpart.length; index += 1) {
    const code = localpart.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function validateRoomAliasLocalpart(localpart: string): RoomAliasLocalpartError | null {
  if (localpart === '') return 'empty';
  if (localpart.includes(':')) return 'colon';
  if (/\s/.test(localpart)) return 'whitespace';
  if (hasControlCharacter(localpart)) return 'control';
  return null;
}
