import type { RoomAttachmentContentView, RoomAttachmentView } from '#src/generated/protocol';

export const MARCH = new Date(2024, 2, 12).getTime();
export const FEBRUARY = new Date(2024, 1, 3).getTime();

export function attachment(
  eventId: string,
  content: RoomAttachmentContentView,
  timestamp = MARCH
): RoomAttachmentView {
  return { event_id: eventId, gallery_index: null, sender: '@ana:example.org', timestamp, content };
}

export function image(eventId: string, spoiler: string | null = null): RoomAttachmentView {
  return attachment(eventId, {
    kind: 'image',
    filename: `${eventId}.png`,
    source: `mxc://example.org/${eventId}`,
    mime: 'image/png',
    width: 10,
    height: 10,
    blurhash: null,
    thumbnail: null,
    spoiler,
  });
}

export function file(
  eventId: string,
  filename: string,
  { timestamp = MARCH, mime = 'application/pdf' }: { timestamp?: number; mime?: string } = {}
): RoomAttachmentView {
  return attachment(
    eventId,
    { kind: 'file', filename, source: 'mxc://example.org/file', mime, size: 2_048 },
    timestamp
  );
}

export function links(eventId: string, urls: string[]): RoomAttachmentView {
  return attachment(eventId, { kind: 'link', urls, body: urls.join(' ') });
}
