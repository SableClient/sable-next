import type {
  MediaPreviewConfigView,
  MediaPreviewsView,
  RoomJoinRuleView,
} from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { preferences, setPreference } from './preferences.svelte.js';

export const MEDIA_PREVIEW_EVENT = 'm.media_preview_config';
export const UNSTABLE_MEDIA_PREVIEW_EVENT = 'io.element.msc4278.media_preview_config';

export type MediaPreviews = MediaPreviewsView;
export type InviteAvatars = 'on' | 'off';

export type MediaPreviewConfig = Partial<MediaPreviewConfigView>;

const PRIVATE_JOIN_RULES: readonly RoomJoinRuleView[] = [
  'invite',
  'knock',
  'restricted',
  'knock_restricted',
];

export function previewsShown(level: MediaPreviews, joinRule: RoomJoinRuleView | null): boolean {
  if (level === 'on') return true;
  if (level === 'off') return false;
  return joinRule !== null && PRIVATE_JOIN_RULES.includes(joinRule);
}

class MediaPreviewSettings {
  global = $state.raw<MediaPreviewConfig>({});

  private core: CoreClient | null = null;
  private generation = 0;
  private reads = 0;
  private stopEvents: (() => void) | null = null;

  get mediaPreviews(): MediaPreviews {
    return this.global.media_previews ?? preferences.mediaAutoLoad;
  }

  get inviteAvatars(): InviteAvatars {
    return this.global.invite_avatars ?? 'on';
  }

  start(core: CoreClient): void {
    const generation = ++this.generation;
    this.core = core;
    this.stopEvents?.();
    this.stopEvents = core.subscribeEvents((event) => {
      if (
        event.type === 'account_data_changed' &&
        (event.event_type === MEDIA_PREVIEW_EVENT ||
          event.event_type === UNSTABLE_MEDIA_PREVIEW_EVENT)
      ) {
        void this.pull(generation);
      }
    });
    void this.pull(generation);
  }

  stop(): void {
    this.generation += 1;
    this.core = null;
    this.global = {};
    this.stopEvents?.();
    this.stopEvents = null;
  }

  async roomConfig(roomId: string): Promise<MediaPreviewConfig> {
    const core = this.core;
    if (core === null) return {};
    return core.commands.mediaPreviewConfig(roomId);
  }

  async set(next: MediaPreviewConfig): Promise<void> {
    const core = this.core;
    if (core === null) return;
    this.reads += 1;
    const previous = this.global;
    const merged: MediaPreviewConfig = {
      media_previews: next.media_previews ?? previous.media_previews,
      invite_avatars: next.invite_avatars ?? previous.invite_avatars,
    };
    this.global = merged;
    try {
      await core.commands.setMediaPreviewConfig({
        media_previews: next.media_previews ?? null,
        invite_avatars: next.invite_avatars ?? null,
      });
      if (this.global === merged && next.media_previews) {
        setPreference('mediaAutoLoad', next.media_previews);
      }
    } catch (error) {
      if (this.global === merged) this.global = previous;
      throw error;
    }
  }

  private async pull(generation: number): Promise<void> {
    const read = ++this.reads;
    try {
      const core = this.core;
      if (core === null) return;
      const config = await core.commands.mediaPreviewConfig();
      if (generation === this.generation && read === this.reads) {
        this.global = config;
        if (config.media_previews) setPreference('mediaAutoLoad', config.media_previews);
      }
    } catch (error) {
      console.debug('[sable settings] media preview settings unavailable', error);
    }
  }
}

export const mediaPreviewSettings = new MediaPreviewSettings();
