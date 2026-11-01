import type { TimelineItemView } from '#src/generated/protocol';
import type { MediaItem } from './media-viewer-types.js';
import { galleryEventId, timelineMediaItems } from './media-items.js';
import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';

class MediaViewerState {
  eventId = $state<string | null>(null);
  standaloneItem = $state<MediaItem | null>(null);
  panelItems = $state.raw<MediaItem[] | null>(null);
  timelineItems = $state<() => readonly TimelineItemView[]>(() => []);
  onJump = $state<((eventId: string) => void) | undefined>(undefined);
  items = $derived.by(() =>
    this.standaloneItem
      ? [this.standaloneItem]
      : (this.panelItems ?? timelineMediaItems(this.timelineItems()))
  );
  #standaloneSequence = 0;

  open(
    eventId: string,
    timelineItems: () => readonly TimelineItemView[],
    onJump?: (eventId: string) => void
  ): void {
    this.timelineItems = timelineItems;
    this.standaloneItem = null;
    this.panelItems = null;
    this.onJump = onJump;
    this.eventId = eventId;
  }

  openPanel(items: MediaItem[], eventId: string, onJump?: (eventId: string) => void): void {
    this.standaloneItem = null;
    this.panelItems = items;
    this.onJump = onJump;
    this.eventId = eventId;
  }

  openStandalone(
    source: string,
    displayName: string,
    mime?: string | null,
    width?: number | null,
    height?: number | null
  ): void {
    const standalone: MediaItem = {
      kind: 'image',
      filename: displayName,
      caption: null,
      html: null,
      source,
      external_url: null,
      mime: mime ?? null,
      width: width ?? null,
      height: height ?? null,
      size: null,
      blurhash: null,
      thumbnail: null,
      spoiler: null,
      animated: null,
      sender: displayName,
      eventId: `standalone-${String(++this.#standaloneSequence)}`,
    };

    this.standaloneItem = standalone;
    this.panelItems = null;
    this.onJump = undefined;
    this.eventId = standalone.eventId;
  }

  jump(eventId: string): void {
    const onJump = this.onJump;
    this.close();
    if (onJump) {
      void afterOverlayPops().then(() => {
        onJump(galleryEventId(eventId));
      });
    }
  }

  close(): void {
    this.timelineItems = () => [];
    this.standaloneItem = null;
    this.panelItems = null;
    this.onJump = undefined;
    this.eventId = null;
  }
}

export const mediaViewerState = new MediaViewerState();
