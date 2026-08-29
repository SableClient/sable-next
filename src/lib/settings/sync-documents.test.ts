// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearDrafts,
  readDraft,
  writeDraft,
} from '#lib/features/composer/composer-drafts.svelte.js';
import { adoptFavorites, favoriteGifs } from '#lib/features/gif/favorites.svelte.js';
import {
  adoptRoomIconOverrides,
  roomIconOverrides,
} from '#lib/features/room/settings/room-appearance.svelte.js';
import { readRecent, writeRecent } from '#lib/emoji/recent-packs.svelte.js';
import { adoptRecentReactions, recentReactionEntries } from '#lib/emoji/recents.svelte.js';
import { SpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';

import { draftsDocument, recentEmojiDocument, workspaceDocument } from './sync-documents';

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
  writeRecent([]);
  adoptFavorites([]);
  adoptRoomIconOverrides([]);
  adoptRecentReactions([]);
  clearDrafts();
  localStorage.clear();
}

beforeEach(reset);
afterEach(reset);

describe('the workspace document', () => {
  it('round-trips picker and layout state', () => {
    const sidebar = new SpaceSidebar();
    const document = workspaceDocument(sidebar);

    writeRecent(['blobwave']);
    adoptFavorites([gif]);
    adoptRoomIconOverrides([['!room:example.org', 'never']]);
    sidebar.adoptOpenFolders(['folder-1']);
    const { content } = document.snapshot();

    reset();
    sidebar.adoptOpenFolders([]);
    expect(document.adopt(content)).toBe(true);

    expect(readRecent()).toEqual(['blobwave']);
    expect(favoriteGifs()).toEqual([gif]);
    expect(roomIconOverrides()).toEqual({ '!room:example.org': 'never' });
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

  it('asks to be seeded only when there is something local to seed with', () => {
    const document = workspaceDocument(new SpaceSidebar());

    expect(document.adopt(null)).toBe(true);

    writeRecent(['blobwave']);
    expect(document.adopt(null)).toBe(false);
  });
});

describe('the drafts document', () => {
  it('carries the editor document and not the staged files', () => {
    writeDraft('!room:example.org', {
      doc: { type: 'doc' },
      staged: [{ id: 1, file: new File([], 'cat.png') }],
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
});

describe('the recent emoji document', () => {
  it('writes the shape the spec defines', () => {
    adoptRecentReactions([{ emoji: '🐈', total: 3 }]);

    expect(recentEmojiDocument.snapshot().content).toEqual({
      recent_emoji: [{ emoji: '🐈', total: 3 }],
    });
  });

  it('reads what an older client wrote as pairs', () => {
    expect(recentEmojiDocument.adopt({ recent_emoji: [['🐈', 3]] })).toBe(true);
    expect(recentReactionEntries()).toEqual([{ emoji: '🐈', total: 3 }]);
  });
});
