// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemContentView, TimelineItemView } from '#src/generated/protocol';

const core = vi.hoisted(() => ({
  commands: {
    fetchMedia: vi
      .fn<() => Promise<Uint8Array<ArrayBuffer>>>()
      .mockResolvedValue(new Uint8Array(new ArrayBuffer(1))),
  },
}));

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

import MessageBody from './MessageBody.svelte';

afterEach(() => {
  core.commands.fetchMedia.mockClear();
  document.body.replaceChildren();
});

function item(content: TimelineItemContentView): TimelineItemView {
  return {
    id: 'item',
    event_id: '$item',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content,
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    mention: 'none',
  };
}

function attachment(kind: 'image' | 'video' | 'audio' | 'file'): TimelineItemContentView {
  const html =
    '<a href="https://matrix.to/#/@ana:example.org">Ana</a> <img src="mxc://example.org/party" alt="party" data-mx-emoticon>';
  const base = { body: 'caption', html, source: 'mxc://example.org/media', mime: null };

  switch (kind) {
    case 'image':
      return {
        ...base,
        kind,
        filename: 'photo.png',
        width: null,
        height: null,
        blurhash: null,
        spoiler: null,
      };
    case 'video':
      return { ...base, kind, width: null, height: null, blurhash: null, spoiler: null };
    case 'audio':
      return { ...base, kind, duration_ms: null, waveform: null, voice: false };
    case 'file':
      return { ...base, kind, size: null };
  }
}

test.each(['image', 'video', 'audio', 'file'] as const)(
  'renders formatted mention and custom emote captions for %s attachments',
  async (kind) => {
    const instance = mount(MessageBody, {
      target: document.body,
      props: { item: item(attachment(kind)), canRedactOthers: false },
    });
    await tick();

    const mention = document.querySelector<HTMLAnchorElement>('a[href*="matrix.to"]');
    expect(mention?.dataset.matrixLink).toBe('user');
    expect(mention?.textContent).toBe('@Ana');
    expect(document.querySelector('img[data-mx-emoticon]')?.getAttribute('alt')).toBe('party');

    await unmount(instance);
  }
);

test('keeps an image filename hidden without the alt-text preference', async () => {
  const instance = mount(MessageBody, {
    target: document.body,
    props: {
      item: item({
        kind: 'image',
        body: 'photo.png',
        html: null,
        source: 'mxc://example.org/photo',
        filename: null,
        mime: 'image/png',
        width: null,
        height: null,
        blurhash: null,
        spoiler: null,
      }),
      canRedactOthers: false,
    },
  });
  await tick();

  expect(document.querySelector('.body')).toBeNull();
  await unmount(instance);
});
