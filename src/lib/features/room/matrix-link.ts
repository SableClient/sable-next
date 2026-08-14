export type MatrixLink =
  | { kind: 'user'; userId: string }
  | { kind: 'room'; roomId: string }
  | { kind: 'event'; roomId: string; eventId: string };

const matrixToHost = 'matrix.to';

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function parsePath(path: string): MatrixLink | null {
  const segments = path.replace(/^\/+/, '').split('/');
  const type = segments[0]?.toLowerCase();
  const id = segments[1] ? decode(segments[1]) : null;
  if (!type || !id) return null;

  if ((type === 'u' || type === 'user') && segments.length === 2) {
    return { kind: 'user', userId: `@${id}` };
  }

  const roomSigil = type === 'r' || type === 'room' ? '#' : type === 'roomid' ? '!' : null;
  if (!roomSigil) return null;
  const roomId = `${roomSigil}${id}`;
  if (segments.length === 2) return { kind: 'room', roomId };

  const eventType = segments[2]?.toLowerCase();
  const eventId = segments[3] ? decode(segments[3]) : null;
  if ((eventType === 'e' || eventType === 'event') && eventId && segments.length === 4) {
    return { kind: 'event', roomId, eventId: `$${eventId}` };
  }
  return null;
}

function parseMatrixTo(href: string): MatrixLink | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.hostname !== matrixToHost) return null;
    const path = url.hash.replace(/^#\/?/, '');
    if (!path) return null;

    const segments = path.split('/');
    const first = segments[0] ? decode(segments[0]) : null;
    if (!first) return null;
    if (first.startsWith('@') && segments.length === 1) return { kind: 'user', userId: first };
    if (!first.startsWith('!') && !first.startsWith('#')) return null;
    if (segments.length === 1) return { kind: 'room', roomId: first };
    const eventId = segments[1] ? decode(segments[1]) : null;
    return eventId?.startsWith('$') ? { kind: 'event', roomId: first, eventId } : null;
  } catch {
    return null;
  }
}

/** Parses the Matrix URI and matrix.to permalink forms handled by V1. */
export function parseMatrixLink(href: string): MatrixLink | null {
  if (href.toLowerCase().startsWith('matrix:')) {
    try {
      const url = new URL(href);
      return url.protocol === 'matrix:' ? parsePath(url.pathname) : null;
    } catch {
      return null;
    }
  }
  return parseMatrixTo(href);
}
