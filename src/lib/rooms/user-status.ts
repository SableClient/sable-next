import type { ProfileView, StatusView } from '#src/generated/protocol';

import type { PresenceEntry } from './presence.svelte.js';

export function resolveUserStatus(
  profile: Pick<ProfileView, 'status'> | null | undefined,
  presence: Pick<PresenceEntry, 'statusMessage'> | null | undefined
): StatusView | null {
  const fromProfile = profile?.status;
  if (fromProfile) {
    const text = fromProfile.text.trim();
    if (text) return { text, emoji: fromProfile.emoji };
  }

  const fromPresence = presence?.statusMessage?.trim();
  if (fromPresence) return { text: fromPresence, emoji: null };

  return null;
}
