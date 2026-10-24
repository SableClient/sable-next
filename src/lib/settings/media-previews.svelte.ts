import type {
  InviteAvatarsView,
  MediaPreviewConfigView,
  MediaPreviewsView,
  RoomJoinRuleView,
} from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { AccountDataSync } from '#lib/core/account-data-sync.js';
import { preferences, setPreference } from './preferences.svelte.js';

export const MEDIA_PREVIEW_EVENT = 'm.media_preview_config';
export const UNSTABLE_MEDIA_PREVIEW_EVENT = 'io.element.msc4278.media_preview_config';

export type MediaPreviews = MediaPreviewsView;
export type InviteAvatars = InviteAvatarsView;

export type MediaPreviewConfig = Partial<MediaPreviewConfigView>;

const PRIVATE_JOIN_RULES: ReadonlySet<RoomJoinRuleView> = new Set([
  'invite',
  'knock',
  'restricted',
  'knock_restricted',
]);

export function previewsShown(level: MediaPreviews, joinRule: RoomJoinRuleView | null): boolean {
  if (level === 'on') return true;
  if (level === 'off') return false;
  return joinRule !== null && PRIVATE_JOIN_RULES.has(joinRule);
}

class MediaPreviewSettings {
  global = $state.raw<MediaPreviewConfig>({});

  private reads = 0;

  private readonly sync = new AccountDataSync(
    [MEDIA_PREVIEW_EVENT, UNSTABLE_MEDIA_PREVIEW_EVENT],
    (generation) => this.pull(generation)
  );

  get mediaPreviews(): MediaPreviews {
    return this.global.media_previews ?? preferences.mediaAutoLoad;
  }

  get inviteAvatars(): InviteAvatars {
    return this.global.invite_avatars ?? 'on';
  }

  start(core: CoreClient): void {
    this.sync.start(core);
  }

  stop(): void {
    this.sync.stop();
    this.global = {};
  }

  async roomConfig(roomId: string): Promise<MediaPreviewConfig> {
    const core = this.sync.core;
    if (core === null) return {};
    return core.rpc.account.mediaPreviewConfig({ room_id: roomId });
  }

  async set(next: MediaPreviewConfig): Promise<void> {
    const core = this.sync.core;
    if (core === null) return;
    this.reads += 1;
    const previous = this.global;
    const merged: MediaPreviewConfig = {
      media_previews: next.media_previews ?? previous.media_previews,
      invite_avatars: next.invite_avatars ?? previous.invite_avatars,
    };
    this.global = merged;
    try {
      await core.rpc.account.setMediaPreviewConfig({
        config: {
          media_previews: next.media_previews ?? null,
          invite_avatars: next.invite_avatars ?? null,
        },
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
      const core = this.sync.core;
      if (core === null) return;
      const config = await core.rpc.account.mediaPreviewConfig({ room_id: null });
      if (generation === this.sync.generation && read === this.reads) {
        this.global = config;
        if (config.media_previews) setPreference('mediaAutoLoad', config.media_previews);
      }
    } catch (error) {
      console.debug('[sable settings] media preview settings unavailable', error);
    }
  }
}

export const mediaPreviewSettings = new MediaPreviewSettings();
