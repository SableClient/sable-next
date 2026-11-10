// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearDraft,
  clearDrafts,
  readDraft,
  writeDraft,
} from '#lib/composer/composer-drafts.svelte.js';
import {
  adoptFavorites,
  adoptRecentGifs,
  favoriteGifs,
  recentGifs,
} from '#lib/gif/favorites.svelte.js';
import { adoptRoomIconOverrides, roomIconOverrides } from '#lib/rooms/room-appearance.svelte.js';
import { adoptBridgedSpaces, bridgedSpaces } from '#lib/rooms/bridged-spaces.svelte.js';
import { adoptQuietRooms, quietRooms } from '#lib/rooms/quiet-rooms.svelte.js';
import { readRecentStickers, writeRecentStickers } from '#lib/emoji/recent-packs.svelte.js';
import { SpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';

import { customThemes, installCustomTheme, replaceCustomThemes } from './custom-themes.svelte';
import { draftsDocumentFor, settingsDocument, workspaceDocument } from './sync-documents';

const draftsDocument = draftsDocumentFor('');

const gif = {
  id: 'abc',
  title: 'a cat',
  mediaUrl: 'https://media.tenor.com/abc/cat.gif',
  previewUrl: 'https://media.tenor.com/abc/tiny.gif',
  width: 320,
  height: 240,
  size: 1000,
  mimetype: 'image/gif',
};

function reset(): void {
  writeRecentStickers([]);
  adoptFavorites([]);
  adoptRecentGifs([]);
  adoptRoomIconOverrides([]);
  adoptQuietRooms([]);
  adoptBridgedSpaces([]);
  clearDrafts();
  localStorage.clear();
}

beforeEach(reset);
afterEach(reset);

describe('the workspace document', () => {
  it('round-trips picker and layout state', () => {
    const sidebar = new SpaceSidebar();
    const document = workspaceDocument(sidebar);

    writeRecentStickers(['party']);
    adoptFavorites([gif]);
    adoptRecentGifs([gif]);
    adoptRoomIconOverrides([['!room:example.org', 'never']]);
    adoptQuietRooms(['!space:example.org']);
    adoptBridgedSpaces(['!bridged:example.org']);
    sidebar.adoptOpenFolders(['folder-1']);
    const { content } = document.snapshot();

    reset();
    sidebar.adoptOpenFolders([]);
    expect(document.adopt(content)).toBe(true);

    expect(content).not.toHaveProperty('recentEmotes');
    expect(readRecentStickers()).toEqual(['party']);
    expect(favoriteGifs()).toEqual([gif]);
    expect(recentGifs()).toEqual([gif]);
    expect(roomIconOverrides()).toEqual({ '!room:example.org': 'never' });
    expect(quietRooms()).toEqual(['!space:example.org']);
    expect(bridgedSpaces()).toEqual(['!bridged:example.org']);
    expect([...sidebar.openFolders]).toEqual(['folder-1']);
  });

  it('drops a favourite pointing off a provider CDN', () => {
    const document = workspaceDocument(new SpaceSidebar());

    expect(
      document.adopt({
        v: 1,
        favoriteGifs: [{ ...gif, mediaUrl: 'https://evil.example/cat.gif' }, gif],
      })
    ).toBe(true);
    expect(favoriteGifs()).toEqual([gif]);
  });

  it('keeps what it holds for a field an older build left out', () => {
    const document = workspaceDocument(new SpaceSidebar());
    adoptBridgedSpaces(['!bridged:example.org']);

    expect(document.adopt({ v: 1, quietRooms: ['!space:example.org'] })).toBe(true);

    expect(quietRooms()).toEqual(['!space:example.org']);
    expect(bridgedSpaces()).toEqual(['!bridged:example.org']);
  });

  it('asks to be seeded only when there is something local to seed with', () => {
    const document = workspaceDocument(new SpaceSidebar());

    expect(document.adopt(null)).toBe(true);

    writeRecentStickers(['party']);
    expect(document.adopt(null)).toBe(false);

    writeRecentStickers([]);
    adoptRecentGifs([gif]);
    expect(document.adopt(null)).toBe(false);
  });
});

describe('the settings document', () => {
  const noThemes = {
    themes: [],
    tweaks: [],
    lightThemeId: null,
    darkThemeId: null,
    enabledTweakIds: [],
  };

  afterEach(() => {
    replaceCustomThemes(noThemes);
  });

  it('keeps the installed themes when a newly added account holds none', () => {
    const { content } = settingsDocument.snapshot();
    const empty = { ...(content as object), themes: noThemes };
    installCustomTheme({ id: 'mine', name: 'Mine', kind: 'dark', css: 'body {}' });

    expect(settingsDocument.adopt(empty, true)).toBe(true);

    expect(customThemes.themes.map((theme) => theme.id)).toEqual(['mine']);
    expect(customThemes.darkThemeId).toBe('mine');
  });

  it('lets an account that was synced before remove themes', () => {
    const { content } = settingsDocument.snapshot();
    const empty = { ...(content as object), themes: noThemes };
    installCustomTheme({ id: 'mine', name: 'Mine', kind: 'dark', css: 'body {}' });

    expect(settingsDocument.adopt(empty, false)).toBe(true);

    expect(customThemes.themes).toEqual([]);
  });
});

describe('the drafts document', () => {
  it('carries the editor document and not the staged files', () => {
    writeDraft('!room:example.org', {
      doc: { type: 'doc' },
      staged: [{ id: 1, file: new File([], 'cat.png'), spoiler: false, metadata: 'location' }],
      nextStagedId: 2,
    });

    expect(draftsDocument.snapshot().content).toEqual({
      v: 1,
      drafts: { '!room:example.org': { type: 'doc' } },
    });
  });

  it('never overwrites a draft this device is already holding', () => {
    writeDraft('!room:example.org', { doc: { type: 'local' }, staged: [], nextStagedId: 0 });

    expect(
      draftsDocument.adopt({
        v: 1,
        drafts: {
          '!room:example.org': { type: 'remote' },
          '!other:example.org': { type: 'remote' },
        },
      })
    ).toBe(true);

    expect(readDraft('!room:example.org')?.doc).toEqual({ type: 'local' });
    expect(readDraft('!other:example.org')?.doc).toEqual({ type: 'remote' });
  });

  it('follows later remote edits to a draft it adopted', () => {
    draftsDocument.adopt({ v: 1, drafts: { '!room:example.org': { type: 'first' } } });
    draftsDocument.adopt({ v: 1, drafts: { '!room:example.org': { type: 'second' } } });

    expect(readDraft('!room:example.org')?.doc).toEqual({ type: 'second' });
  });

  it('drops an adopted draft once another device sends it', () => {
    draftsDocument.adopt({ v: 1, drafts: { '!room:example.org': { type: 'first' } } });
    draftsDocument.adopt({ v: 1, drafts: {} });

    expect(readDraft('!room:example.org')).toBeUndefined();
  });

  it('keeps an adopted draft this device has since edited', () => {
    draftsDocument.adopt({ v: 1, drafts: { '!room:example.org': { type: 'first' } } });
    writeDraft('!room:example.org', { doc: { type: 'local' }, staged: [], nextStagedId: 0 });
    draftsDocument.adopt({ v: 1, drafts: {} });

    expect(readDraft('!room:example.org')?.doc).toEqual({ type: 'local' });
  });

  it('does not resurrect a sent draft from the echo of its own upload', () => {
    writeDraft('!room:example.org', { doc: { type: 'sent' }, staged: [], nextStagedId: 0 });
    clearDraft('!room:example.org');
    draftsDocument.adopt({ v: 1, drafts: { '!room:example.org': { type: 'sent' } } });

    expect(readDraft('!room:example.org')).toBeUndefined();
  });

  it('does not resurrect a sent draft the remote still holds', () => {
    writeDraft('!room:example.org', { doc: { type: 'sent' }, staged: [], nextStagedId: 0 });
    draftsDocument.adopt({ v: 1, drafts: { '!room:example.org': { type: 'sent' } } });
    clearDraft('!room:example.org');
    draftsDocument.adopt({ v: 1, drafts: { '!room:example.org': { type: 'sent' } } });

    expect(readDraft('!room:example.org')).toBeUndefined();
  });

  it('adopts a new remote draft for a room whose draft was sent', () => {
    writeDraft('!room:example.org', { doc: { type: 'sent' }, staged: [], nextStagedId: 0 });
    clearDraft('!room:example.org');
    draftsDocument.adopt({ v: 1, drafts: { '!room:example.org': { type: 'next' } } });

    expect(readDraft('!room:example.org')?.doc).toEqual({ type: 'next' });
  });
});
