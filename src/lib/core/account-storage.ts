const ACCOUNT_KEY_PREFIXES = [
  'sable.room-list.',
  'sable-sync-base:',
  'sable.account-config.',
  'sable-last-room:',
  'sable-last-room-section:',
];

/** A device backup restores this storage without the core's accounts, whose ids then start over. */
export function forgetAccountStorage(): void {
  if (import.meta.env.VITE_SABLE_SERVER_URL) return;
  try {
    const stale = Object.keys(localStorage).filter((key) =>
      ACCOUNT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    );
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    return;
  }
}
