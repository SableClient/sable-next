import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import type { MediaItem } from './media/media-viewer-types.js';
import { timelineMediaItems } from './media/media-items.js';
import type { StandaloneMedia } from './media/media-viewer-opener.svelte.js';

export class RoomMediaViewer {
  eventId = $state<string | null>(null);
  standaloneItem = $state<MediaItem | null>(null);
  panelItems = $state.raw<MediaItem[] | null>(null);
  items = $derived.by(() =>
    this.standaloneItem
      ? [this.standaloneItem]
      : (this.panelItems ??
        (this.timelineItems === null ? [] : timelineMediaItems(this.timelineItems())))
  );
  #standaloneSequence = 0;

  constructor(private readonly timelineItems: (() => readonly ResolvedItem[]) | null) {}

  open(eventId: string): void {
    this.standaloneItem = null;
    this.panelItems = null;
    this.eventId = eventId;
  }

  openPanel(items: MediaItem[], eventId: string): void {
    this.standaloneItem = null;
    this.panelItems = items;
    this.eventId = eventId;
  }

  openStandalone(item: StandaloneMedia): void {
    this.panelItems = null;
    const standalone = { ...item, eventId: `standalone-${String(++this.#standaloneSequence)}` };
    this.standaloneItem = standalone;
    this.eventId = standalone.eventId;
  }

  openProfile(source: string, displayName: string): void {
    this.openStandalone({
      kind: 'image',
      filename: displayName,
      caption: null,
      html: null,
      source,
      mime: null,
      width: null,
      height: null,
      size: null,
      blurhash: null,
      thumbnail: null,
      spoiler: null,
      animated: null,
      sender: displayName,
    });
  }

  close(): void {
    this.eventId = null;
    this.standaloneItem = null;
    this.panelItems = null;
  }
}
