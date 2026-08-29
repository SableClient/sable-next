import {
  adoptDraftDocuments,
  draftDocuments,
} from '#lib/features/composer/composer-drafts.svelte.js';
import {
  adoptFavorites,
  favoriteGifs,
  parseFavorites,
} from '#lib/features/gif/favorites.svelte.js';
import {
  adoptRoomIconOverrides,
  parseRoomIconOverrides,
  roomIconOverrides,
} from '#lib/features/room/settings/room-appearance.svelte.js';
import { parseShortcodes, readRecent, writeRecent } from '#lib/emoji/recent-packs.svelte.js';
import {
  adoptRecentReactions,
  parseRecentReactions,
  recentReactionEntries,
} from '#lib/emoji/recents.svelte.js';
import type { SpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';

import type { SyncedDocument } from './account-sync.svelte.js';
import { customThemes, replaceCustomThemes } from './custom-themes.svelte.js';
import { applyPreferences, preferences } from './preferences.svelte.js';
import { applySettings, prepareSettings, SETTINGS_ACCOUNT_DATA_TYPE } from './sync.js';

export const WORKSPACE_ACCOUNT_DATA_TYPE = 'moe.sable.next.workspace';
export const DRAFTS_ACCOUNT_DATA_TYPE = 'moe.sable.next.drafts';
export const RECENT_EMOJI_ACCOUNT_DATA_TYPE = 'm.recent_emoji';

const DOCUMENT_VERSION = 1;
const DRAFT_DEBOUNCE_MS = 5000;

let excludedThemeIds: readonly string[] = [];

export const settingsDocument: SyncedDocument = {
  eventType: SETTINGS_ACCOUNT_DATA_TYPE,

  snapshot() {
    const prepared = prepareSettings(preferences, customThemes);
    excludedThemeIds = prepared.excludedThemeIds;
    return { content: prepared.content, partial: prepared.excludedThemeIds.length > 0 };
  },

  adopt(content) {
    const applied = applySettings(content, preferences, customThemes, excludedThemeIds);
    if (applied === null) return false;

    applyPreferences(applied.preferences);
    replaceCustomThemes(applied.themes);
    return true;
  },
};

export function workspaceDocument(sidebar: SpaceSidebar): SyncedDocument {
  return {
    eventType: WORKSPACE_ACCOUNT_DATA_TYPE,

    snapshot: () => ({
      content: {
        v: DOCUMENT_VERSION,
        recentEmotes: readRecent(),
        favoriteGifs: favoriteGifs(),
        roomIcons: roomIconOverrides(),
        openFolders: [...sidebar.openFolders],
      },
    }),

    adopt(content) {
      const body = versioned(content);
      if (body === null) {
        return (
          readRecent().length === 0 &&
          favoriteGifs().length === 0 &&
          Object.keys(roomIconOverrides()).length === 0 &&
          sidebar.openFolders.size === 0
        );
      }

      writeRecent(parseShortcodes(body.recentEmotes));
      adoptFavorites(parseFavorites(body.favoriteGifs));
      adoptRoomIconOverrides(parseRoomIconOverrides(body.roomIcons));
      sidebar.adoptOpenFolders(stringList(body.openFolders));
      return true;
    },
  };
}

export const draftsDocument: SyncedDocument = {
  eventType: DRAFTS_ACCOUNT_DATA_TYPE,
  debounceMs: DRAFT_DEBOUNCE_MS,
  enabled: () => preferences.syncDrafts,

  snapshot: () => ({ content: { v: DOCUMENT_VERSION, drafts: draftDocuments() } }),

  adopt(content) {
    const body = versioned(content);
    if (body === null) return Object.keys(draftDocuments()).length === 0;

    const drafts = body.drafts;
    if (drafts === null || typeof drafts !== 'object' || Array.isArray(drafts)) return false;

    adoptDraftDocuments(drafts as Record<string, unknown>);
    return true;
  },
};

export const recentEmojiDocument: SyncedDocument = {
  eventType: RECENT_EMOJI_ACCOUNT_DATA_TYPE,

  snapshot: () => ({ content: { recent_emoji: recentReactionEntries() } }),

  adopt(content) {
    if (content === null || typeof content !== 'object' || Array.isArray(content)) {
      return recentReactionEntries().length === 0;
    }

    adoptRecentReactions(parseRecentReactions((content as Record<string, unknown>).recent_emoji));
    return true;
  },
};

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function versioned(content: unknown): Record<string, unknown> | null {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return null;

  const body = content as Record<string, unknown>;
  return body.v === DOCUMENT_VERSION ? body : null;
}
