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
        size: null,
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
        size: null,
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

test.each(['javascript:alert(document.domain)', 'data:text/html,unsafe', 'geo:invalid'])(
  'does not turn an invalid location into a navigable link: %s',
  async (geoUri) => {
    const instance = mount(MessageBody, {
      target: document.body,
      props: {
        item: item({
          kind: 'location',
          body: 'Here',
          geo_uri: geoUri,
          latitude: null,
          longitude: null,
        }),
        canRedactOthers: false,
      },
    });
    await tick();
    expect(document.querySelector('a[href]')).toBeNull();
    expect(document.body.textContent).toContain('Here');
    await unmount(instance);
  }
);

test('opens a valid location using validated coordinates', async () => {
  const instance = mount(MessageBody, {
    target: document.body,
    props: {
      item: item({
        kind: 'location',
        body: 'Here',
        geo_uri: 'geo:48.8,2.3',
        latitude: 48.8,
        longitude: 2.3,
      }),
      canRedactOthers: false,
    },
  });
  await tick();
  expect(document.querySelector('a')?.getAttribute('href')).toBe('geo:48.8,2.3');
  await unmount(instance);
});

test.each(['image', 'video'] as const)(
  'hides %s spoilers and their captions until revealed',
  async (kind) => {
    const content = { ...attachment(kind), spoiler: 'Ending' } as TimelineItemContentView;
    const instance = mount(MessageBody, {
      target: document.body,
      props: { item: item(content), canRedactOthers: false },
    });
    await tick();
    expect(core.commands.fetchMedia).not.toHaveBeenCalled();
    expect(document.querySelector('img, video, .formatted-body')).toBeNull();
    const reveal = document.querySelector<HTMLButtonElement>('button');
    expect(reveal?.textContent).toContain('Ending');
    reveal?.click();
    await tick();
    expect(document.querySelector('.formatted-body')).not.toBeNull();
    await unmount(instance);
  }
);

test('live location expires without another SDK update and keeps its last known coordinates', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const instance = mount(MessageBody, {
    target: document.body,
    props: {
      item: item({
        kind: 'live_location',
        body: 'Here',
        latitude: 48.8,
        longitude: 2.3,
        live: true,
        expires_at: 2_000,
        updated_at: 1_000,
      }),
      canRedactOthers: false,
    },
  });
  await tick();
  expect(document.body.textContent).toContain('Sharing live location');
  await vi.advanceTimersByTimeAsync(1_000);
  await tick();
  expect(document.body.textContent).toContain('Location sharing ended');
  expect(document.querySelector('a')?.getAttribute('href')).toBe('geo:48.8,2.3');
  await unmount(instance);
  vi.useRealTimers();
});
