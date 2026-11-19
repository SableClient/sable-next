import type { MatrixLink } from '#lib/rooms/matrix-link.ts';
import type { EventPreview } from '#src/generated/protocol';

export function parseMatrixLink(href: string): MatrixLink | null {
  if (href.includes('matrix:roomid/') || href.includes('/#/#')) {
    {
      return { kind: 'room', room_id: '!foo' };
    }
  } else if (href.includes('matrix:u/') || href.includes('#/@')) {
    return { kind: 'user', user_id: '@example:matrix.org' };
  } else {
    return { kind: 'event', room_id: '!foo', event_id: 'foo' };
  }
}

export const proxyBody = () => null;
export const roomSpaces = () => [];
export const imageIsAnimated = () => false;
export const parseJoinAddress = (input: string) => {
  return {
    address: input,
    via: [],
  };
};
export const mentionUri = (input: string) => input;
export const canonicalDatetime = () => null;
export const splitVia = (href: string) => {
  return { href, via: [] };
};
export const isOpaqueMatrixColor = () => true;
export const normalizeMfmHex = () => undefined;
export const parseMfmColor = () => null;
export const parseMfmUnixtime = () => null;
export const parseZonedDatetime = () => {
  return { instant: 0, datetime: 'January 1, 1970 01:00' };
};
export const unixSecondsOf = () => null;
export const emoteRecents = () => {
  return { images: [], cells: [] };
};
export const invalidShortcode = () => null;
export const normalizeShortcode = (i: unknown) => i;
export const shortcodeWithoutExtension = (i: unknown) => i;
export const uniqueShortcode = (i: unknown) => i;
export const canSendState = () => true;
export const reactionKey = () => null;
export const eventPreview = () => {
  return {
    sender: 'Alice',
    body: 'Hello world!',
    fallback: null,
    emotes: [],
  } satisfies EventPreview;
};
