import type { RoomJoinRuleView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord } from '#lib/guards.js';

export const MEDIA_PREVIEW_EVENT = 'm.media_preview_config';
export const UNSTABLE_MEDIA_PREVIEW_EVENT = 'io.element.msc4278.media_preview_config';

export type MediaPreviews = 'on' | 'private' | 'off';
export type InviteAvatars = 'on' | 'off';

export interface MediaPreviewConfig {
  media_previews?: MediaPreviews;
  invite_avatars?: InviteAvatars;
}

const PRIVATE_JOIN_RULES: readonly RoomJoinRuleView[] = [
  'invite',
  'knock',
  'restricted',
  'knock_restricted',
];

export function parseMediaPreviewConfig(content: unknown): MediaPreviewConfig {
  if (!isRecord(content)) return {};
  const config: MediaPreviewConfig = {};
  if ('media_previews' in content) {
    const value = content.media_previews;
    config.media_previews = value === 'on' || value === 'private' ? value : 'off';
  }
  if ('invite_avatars' in content) {
    config.invite_avatars = content.invite_avatars === 'on' ? 'on' : 'off';
  }
  return config;
}

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
    return this.global.media_previews ?? 'on';
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
    const stable = await core.commands.roomAccountData(roomId, MEDIA_PREVIEW_EVENT);
    const content =
      stable ?? (await core.commands.roomAccountData(roomId, UNSTABLE_MEDIA_PREVIEW_EVENT));
    return parseMediaPreviewConfig(content);
  }

  async set(next: MediaPreviewConfig): Promise<void> {
    const core = this.core;
    if (core === null) return;
    this.reads += 1;
    const previous = this.global;
    const merged = { ...previous, ...next };
    this.global = merged;
    try {
      await core.commands.setAccountData(MEDIA_PREVIEW_EVENT, merged);
      await core.commands.setAccountData(UNSTABLE_MEDIA_PREVIEW_EVENT, merged);
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
      const stable = await core.commands.accountData(MEDIA_PREVIEW_EVENT);
      const content = stable ?? (await core.commands.accountData(UNSTABLE_MEDIA_PREVIEW_EVENT));
      if (generation === this.generation && read === this.reads) {
        this.global = parseMediaPreviewConfig(content);
      }
    } catch (error) {
      console.debug('[sable settings] media preview settings unavailable', error);
    }
  }
}

export const mediaPreviewSettings = new MediaPreviewSettings();
