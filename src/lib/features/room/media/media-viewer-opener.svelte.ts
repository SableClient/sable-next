import { createContext } from 'svelte';

import type { MediaItem } from './media-viewer-types.js';

/** A media viewer item without an event, such as a profile avatar or a link preview image. */
export type StandaloneMedia = Omit<Extract<MediaItem, { kind: 'image' }>, 'eventId'>;

export const [useMediaViewerOpener, provideMediaViewerOpener, hasMediaViewerOpener] =
  createContext<(item: StandaloneMedia) => void>();
