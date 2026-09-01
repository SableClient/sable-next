export const UTD_GRACE_MS = 5000;

const MAX_TRACKED = 512;
const TRIM_SLACK = 128;

const firstSeen = new Map<string, number>();

export function utdGraceRemaining(id: string, now = Date.now()): number {
  let seen = firstSeen.get(id);
  if (seen === undefined) {
    seen = now;
    firstSeen.set(id, seen);
    if (firstSeen.size > MAX_TRACKED + TRIM_SLACK) trim();
  }
  return Math.max(0, seen + UTD_GRACE_MS - now);
}

function trim(): void {
  const excess = firstSeen.size - MAX_TRACKED;
  let dropped = 0;
  for (const key of firstSeen.keys()) {
    if (dropped >= excess) break;
    firstSeen.delete(key);
    dropped += 1;
  }
}
