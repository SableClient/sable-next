// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import type { TimelineItemView, UrlPreviewView } from '#src/generated/protocol';

import { setPreference } from '#lib/settings/preferences.svelte.js';

import { resetUrlPreviews, shownLinkPreviews } from '../media/link-preview-cache';
import { MessageLinkPreviews } from './message-link-previews.svelte';
import { item } from './timeline-item-fixtures';

afterEach(() => {
  resetUrlPreviews();
  setPreference('urlPreviews', false);
});

function preview(url: string): UrlPreviewView {
  return {
    url,
    title: null,
    description: null,
    site_name: null,
    image: null,
    image_mime: null,
    image_width: null,
    image_height: null,
    video: null,
    theme_color: null,
    card: null,
    author_name: null,
    post: null,
  };
}

const bundled = preview('https://example.org/b');

function withHtml(html: string): TimelineItemView {
  const view = item(false);
  if (view.content.kind !== 'message') throw new Error('fixture');
  return { ...view, content: { ...view.content, html, body: html } };
}

test('has no previews for plain text', () => {
  const previews = new MessageLinkPreviews(() => item(false));
  expect(previews.any).toBe(false);
  expect(previews.shown).toEqual([]);
});

test('bundled previews win over message links', () => {
  const view = {
    ...withHtml('<a href="https://example.org/x">x</a>'),
    bundled_link_previews: [bundled],
  };
  const previews = new MessageLinkPreviews(() => view);
  expect(previews.bundled).toEqual([bundled]);
  expect(previews.urls).toEqual([]);
  expect(previews.shown).toEqual([bundled]);
});

test('removed previews hide bundled and linked ones', () => {
  const view = {
    ...withHtml('<a href="https://example.org/x">x</a>'),
    bundled_link_previews: [bundled],
    link_previews_removed: true,
  };
  const previews = new MessageLinkPreviews(() => view);
  expect(previews.any).toBe(false);
});

test('shows only the loaded previews of linked urls', () => {
  setPreference('urlPreviews', true);
  const link = 'https://example.org/x';
  const previews = new MessageLinkPreviews(() => withHtml(`<a href="${link}">${link}</a>`));
  expect(previews.urls).toEqual([link]);
  expect(previews.any).toBe(true);
  expect(previews.shown).toEqual([]);
  const loaded = preview(link);
  shownLinkPreviews.set(link, loaded);
  expect(previews.shown).toEqual([loaded]);
});
