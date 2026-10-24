import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { vi } from 'vitest';

import type { UrlPreviewView } from '#src/generated/protocol';

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import { withRowFields } from './row-fixtures.js';

export const core = Object.assign(baseCore, {
  pinnedEvents: vi.fn(() => Promise.resolve<string[]>([])),
  setPinned: vi.fn(() => Promise.resolve<string[]>([])),
  bookmarks: vi.fn(() => Promise.resolve([])),
  setBookmark: vi.fn(() => Promise.resolve(false)),
});
Object.assign(core.rpc.messages, {
  urlPreview: vi.fn(({ url }: { url: string }): Promise<UrlPreviewView> =>
    Promise.resolve({
      url,
      title: url,
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
    })
  ),
});

export const user = userEvent.setup({ delay: null });

export async function press(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to press');
  await user.click(element);
}

export async function openMenu(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to open a menu on');
  await user.pointer({ keys: '[MouseRight]', target: element });
}

export async function hover(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to hover');
  await user.hover(element);
}

export const menuItem = (name: string) => screen.getByRole('menuitem', { name: new RegExp(name) });
export const menuLabels = () =>
  screen.getAllByRole('menuitem').map((row) => row.textContent.trim());

export function resetTimelineItemTest(): void {
  document.body.replaceChildren();
  setPreference('replyPreviewStyle', 'connected');
  setPreference('showPronouns', true);
  setPreference('showRoleTooltip', false);
  setPreference('showPronounPills', true);
  core.userProfile.mockReset();
  core.userProfile.mockRejectedValue(new Error('profile unavailable'));
}

export function item(emote: boolean): ResolvedItem {
  return withRowFields({
    id: 'item',
    event_id: '$item',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: 'waves',
      html: 'waves',
      emote,
      notice: false,
      edited: false,
    },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
  });
}

export function imageItem(body = 'photo.png'): ResolvedItem {
  return withRowFields({
    ...item(false),
    content: {
      kind: 'image',
      html: null,
      filename: 'photo.png',
      caption: body,
      source: 'mxc://example.org/photo',
      mime: 'image/png',
      width: 800,
      height: 600,
      size: null,
      blurhash: null,
      thumbnail: null,
      spoiler: null,
      animated: null,
    },
  });
}

export function fileItem(caption: string | null = 'the code'): ResolvedItem {
  return withRowFields({
    ...item(false),
    content: {
      kind: 'file',
      filename: 'main.rs',
      caption,
      html: null,
      source: 'mxc://example.org/code',
      mime: 'text/plain',
      size: 128,
    },
  });
}

export function replyItem(
  body = 'A reply with enough text to show how the preview is rendered.',
  mention: ResolvedItem['mention'] = 'none',
  isMentioned = false
): ResolvedItem {
  return {
    ...item(false),
    mention,
    in_reply_to: {
      event_id: '$original',
      sender: '@bob:example.org',
      sender_mentioned: isMentioned,
      sender_name: 'Bob',
      body,
      fallback: null,
    },
  };
}
