import { adoptDraftDocuments, draftDocuments } from '#lib/composer/composer-drafts.svelte.js';
import {
  adoptFavorites,
  adoptRecentGifs,
  favoriteGifs,
  parseFavorites,
  recentGifs,
} from '#lib/gif/favorites.svelte.js';
import {
  adoptRoomIconOverrides,
  parseRoomIconOverrides,
  roomIconOverrides,
} from '#lib/rooms/room-appearance.svelte.js';
import {
  adoptUngroupedFavourites,
  parseUngroupedFavourites,
  ungroupedFavourites,
} from '#lib/rooms/favourite-grouping.svelte.js';
import { adoptQueue, parseQueue, scheduledQueue } from '#lib/composer/scheduled-queue.svelte.js';
import { adoptQuietRooms, parseQuietRooms, quietRooms } from '#lib/rooms/quiet-rooms.svelte.js';
import {
  parseShortcodes,
  readRecentStickers,
  writeRecentStickers,
} from '#lib/emoji/recent-packs.svelte.js';
import type { SpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';

import type { SyncedDocument } from './account-sync.svelte.js';
import { customThemes, hydrateCatalogThemes, replaceCustomThemes } from './custom-themes.svelte.js';
import { applyPreferences, isExplicitPreference, preferences } from './preferences.svelte.js';
import {
  applySettings,
  mergeSettings,
  prepareSettings,
  SETTINGS_ACCOUNT_DATA_TYPE,
} from './sync.js';

export const WORKSPACE_ACCOUNT_DATA_TYPE = 'moe.sable.next.workspace';
export const DRAFTS_ACCOUNT_DATA_TYPE = 'moe.sable.next.drafts';
export const SCHEDULED_ACCOUNT_DATA_TYPE = 'moe.sable.next.scheduled';

const DOCUMENT_VERSION = 1;
const DRAFT_DEBOUNCE_MS = 5000;

let excludedThemeIds: readonly string[] = [];

export const settingsDocument: SyncedDocument = {
  eventType: SETTINGS_ACCOUNT_DATA_TYPE,

  snapshot() {
    const prepared = prepareSettings(preferences, customThemes, isExplicitPreference);
    excludedThemeIds = prepared.excludedThemeIds;
    const excluded = new Set(prepared.excludedThemeIds);
    const skipped = [...customThemes.themes, ...customThemes.tweaks]
      .filter((entry) => excluded.has(entry.id))
      .map((entry) => entry.name);
    return { content: prepared.content, partial: skipped.length > 0, skipped };
  },

  merge: mergeSettings,

  adopt(content, firstSync) {
    const keptThemeIds = firstSync
      ? [...customThemes.themes, ...customThemes.tweaks].map((entry) => entry.id)
      : [];
    const applied = applySettings(content, preferences, customThemes, [
      ...excludedThemeIds,
      ...keptThemeIds,
    ]);
    if (applied === null) return false;

    applyPreferences(applied.preferences, applied.keys);
    replaceCustomThemes(applied.themes);
    void hydrateCatalogThemes();
    return true;
  },
};

export function workspaceDocument(sidebar: SpaceSidebar): SyncedDocument {
  return {
    eventType: WORKSPACE_ACCOUNT_DATA_TYPE,

    snapshot: () => ({
      content: {
        v: DOCUMENT_VERSION,
        recentStickers: readRecentStickers(),
        favoriteGifs: favoriteGifs(),
        recentGifs: recentGifs(),
        roomIcons: roomIconOverrides(),
        openFolders: [...sidebar.openFolders],
        ungroupedFavourites: ungroupedFavourites(),
        quietRooms: quietRooms(),
      },
    }),

    adopt(content) {
      const body = versioned(content);
      if (body === null) {
        return (
          readRecentStickers().length === 0 &&
          favoriteGifs().length === 0 &&
          recentGifs().length === 0 &&
          Object.keys(roomIconOverrides()).length === 0 &&
          sidebar.openFolders.size === 0 &&
          ungroupedFavourites().length === 0 &&
          quietRooms().length === 0
        );
      }

      writeRecentStickers(parseShortcodes(body.recentStickers));
      adoptFavorites(parseFavorites(body.favoriteGifs));
      adoptRecentGifs(parseFavorites(body.recentGifs));
      adoptRoomIconOverrides(parseRoomIconOverrides(body.roomIcons));
      sidebar.adoptOpenFolders(stringList(body.openFolders));
      adoptUngroupedFavourites(parseUngroupedFavourites(body.ungroupedFavourites));
      adoptQuietRooms(parseQuietRooms(body.quietRooms));
      return true;
    },
  };
}

export function draftsDocumentFor(accountId: string): SyncedDocument {
  return {
    eventType: DRAFTS_ACCOUNT_DATA_TYPE,
    sealed: true,
    debounceMs: DRAFT_DEBOUNCE_MS,
    enabled: () => preferences.syncDrafts,

    snapshot: () => ({ content: { v: DOCUMENT_VERSION, drafts: draftDocuments(accountId) } }),

    adopt(content) {
      const body = versioned(content);
      if (body === null) return Object.keys(draftDocuments(accountId)).length === 0;

      const drafts = body.drafts;
      if (drafts === null || typeof drafts !== 'object' || Array.isArray(drafts)) return false;

      adoptDraftDocuments(drafts as Record<string, unknown>, accountId);
      return true;
    },
  };
}

export function scheduledDocumentFor(accountId: string): SyncedDocument {
  return {
    eventType: SCHEDULED_ACCOUNT_DATA_TYPE,

    snapshot: () => ({ content: { v: DOCUMENT_VERSION, scheduled: scheduledQueue(accountId) } }),

    adopt(content) {
      const body = versioned(content);
      if (body === null) return scheduledQueue(accountId).length === 0;

      adoptQueue(parseQueue(body.scheduled), accountId);
      return true;
    },
  };
}

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
