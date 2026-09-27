import { createContext } from 'svelte';

import type { RoomJoinRuleView } from '#src/generated/protocol';

import {
  mediaPreviewSettings,
  previewsShown,
  type MediaPreviewConfig,
} from '#lib/settings/media-previews.svelte.js';

export class RoomMediaPreviews {
  room = $state.raw<MediaPreviewConfig>({});

  private generation = 0;

  constructor(private readonly joinRule: () => RoomJoinRuleView | null) {}

  get hidden(): boolean {
    const level = this.room.media_previews ?? mediaPreviewSettings.mediaPreviews;
    return !previewsShown(level, this.joinRule());
  }

  async load(roomId: string): Promise<void> {
    const generation = ++this.generation;
    this.room = {};
    try {
      const config = await mediaPreviewSettings.roomConfig(roomId);
      if (generation === this.generation) this.room = config;
    } catch (error) {
      console.debug('[sable room] room media preview settings unavailable', error);
    }
  }
}

export const [useRoomMediaPreviews, provideRoomMediaPreviews, hasRoomMediaPreviews] =
  createContext<RoomMediaPreviews>();
