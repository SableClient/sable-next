import { SvelteMap } from 'svelte/reactivity';

import type { TimelineItemContentView } from '#src/generated/protocol';

/** Redacted content a moderator asked to see (MSC2815), kept in memory only. */
export type RevealState =
  | { kind: 'loading' }
  | { kind: 'shown'; content: TimelineItemContentView }
  | { kind: 'failed'; message: string };

const reveals = new SvelteMap<string, RevealState>();

function key(roomId: string, eventId: string): string {
  return `${roomId}\u0000${eventId}`;
}

export function revealState(roomId: string, eventId: string | null): RevealState | undefined {
  return eventId === null ? undefined : reveals.get(key(roomId, eventId));
}

export function setRevealState(roomId: string, eventId: string, state: RevealState): void {
  reveals.set(key(roomId, eventId), state);
}

export function hideContent(roomId: string, eventId: string): void {
  reveals.delete(key(roomId, eventId));
}
