const KEY_PREFIX = 'sable.room-list.';

/** The runtime saves the room list now, so a copy a build before it left in storage is dropped. */
export function forgetLegacyRoomListSnapshots(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(KEY_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    return;
  }
}
