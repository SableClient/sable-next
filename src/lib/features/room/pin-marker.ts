export const PIN_MARKER_EVENT_TYPE = 'moe.sable.app.pins_read_marker';

export interface PinReadMarker {
  hash: string;
  count: number;
  last_seen_id: string;
}

export async function pinsHash(pinnedIds: readonly string[]): Promise<string> {
  const sorted = [...pinnedIds].sort().join(',');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 10);
}

export function unreadPinCount(
  pinnedIds: readonly string[],
  marker: PinReadMarker | null,
  currentHash: string | null
): number {
  if (pinnedIds.length === 0) return 0;
  if (marker === null) return pinnedIds.length;
  if (currentHash !== null && marker.hash === currentHash) return 0;

  const lastSeen = pinnedIds.indexOf(marker.last_seen_id);
  if (lastSeen !== -1) return pinnedIds.length - lastSeen - 1;

  return Math.max(0, pinnedIds.length - Math.max(0, marker.count - 1));
}

export function isNewPin(
  pinnedIds: readonly string[],
  marker: PinReadMarker | null,
  eventId: string
): boolean {
  if (marker === null) return true;

  const index = pinnedIds.indexOf(eventId);
  const lastSeen = pinnedIds.indexOf(marker.last_seen_id);
  if (lastSeen === -1) return index >= Math.max(0, marker.count - 1);
  return index > lastSeen;
}
