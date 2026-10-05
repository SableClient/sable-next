// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemContentView, TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer(1)));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: new Promise(() => {}), destroy: () => Promise.resolve() }),
}));

import { setPreference } from '#lib/settings/preferences.svelte.js';

import MessageBody from './MessageBody.svelte';
import MessageBodyMediaHarness from './MessageBodyMediaHarness.test.svelte';
import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';

afterEach(() => {
  setPreference('captionPosition', 'below');
  core.commands.fetchMedia.mockClear();
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
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
  };
}

function attachment(kind: 'image' | 'video' | 'audio' | 'file'): TimelineItemContentView {
  const html =
    '<a href="https://matrix.to/#/@ana:example.org">Ana</a> <img src="mxc://example.org/party" alt="party" data-mx-emoticon>';
  const base = {
    filename: 'media.bin',
    caption: 'caption',
    html,
    source: 'mxc://example.org/media',
    mime: null,
  };

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
        thumbnail: null,
        spoiler: null,
        animated: null,
      };
    case 'video':
      return {
        ...base,
        kind,
        width: null,
        height: null,
        blurhash: null,
        thumbnail: null,
        spoiler: null,
      };
    case 'audio':
      return { ...base, kind, duration_ms: null, waveform: null, voice: false, metadata: null };
    case 'file':
      return { ...base, kind, size: null };
  }
}

test.each(['image', 'video', 'audio', 'file'] as const)(
  'renders formatted mention and custom emote captions for %s attachments',
  async (kind) => {
    render(MessageBody, { item: item(attachment(kind)), canRedactOthers: false });
    await tick();

    const mention = screen.getByRole('link', { name: '@ana' });
    expect(mention).toHaveAttribute('data-matrix-link', 'user');
    expect(screen.getByRole('img', { name: 'party' })).toHaveAttribute('data-mx-emoticon');
  }
);

test('opens the selected gallery image', async () => {
  const onOpenMedia = vi.fn();
  render(MessageBody, {
    props: {
      item: item({
        kind: 'gallery',
        body: 'Weekend',
        html: '<p>Weekend</p>',
        items: [
          {
            kind: 'image',
            filename: 'one.png',
            caption: null,
            source: 'mxc://example.org/one',
            mime: 'image/png',
            width: 100,
            height: 100,
            size: null,
            blurhash: null,
            thumbnail: null,
            spoiler: null,
          },
          {
            kind: 'image',
            filename: 'two.png',
            caption: null,
            source: 'mxc://example.org/two',
            mime: 'image/png',
            width: 100,
            height: 100,
            size: null,
            blurhash: null,
            thumbnail: null,
            spoiler: null,
          },
        ],
      }),
      canRedactOthers: false,
      onOpenMedia,
    },
  });
  await tick();

  expect(document.querySelector('.gallery')).toBeInTheDocument();
  expect(screen.getByText('Weekend')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Open two.png' }));

  expect(onOpenMedia).toHaveBeenCalledWith('$item:gallery:1');
});

test('opens a gallery pdf in the viewer', async () => {
  const onOpenMedia = vi.fn();
  render(MessageBody, {
    props: {
      item: item({
        kind: 'gallery',
        body: '',
        html: '',
        items: [
          {
            kind: 'image',
            filename: 'one.png',
            caption: null,
            source: 'mxc://example.org/one',
            mime: 'image/png',
            width: 100,
            height: 100,
            size: null,
            blurhash: null,
            thumbnail: null,
            spoiler: null,
          },
          {
            kind: 'file',
            filename: 'report.pdf',
            caption: null,
            source: 'mxc://example.org/report',
            mime: 'application/pdf',
            size: null,
          },
        ],
      }),
      canRedactOthers: false,
      onOpenMedia,
    },
  });
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await tick();

  await userEvent.click(screen.getByRole('button', { name: 'Open report.pdf' }));

  expect(onOpenMedia).toHaveBeenCalledWith('$item:gallery:1');
});

test('renders gallery items with their captions, sizes and waveforms', async () => {
  render(MessageBody, {
    props: {
      item: item({
        kind: 'gallery',
        body: '',
        html: '',
        items: [
          {
            kind: 'image',
            filename: 'beach.jpg',
            caption: 'the beach',
            source: 'mxc://example.org/beach',
            mime: 'image/jpeg',
            width: 100,
            height: 100,
            size: 2048,
            blurhash: null,
            thumbnail: null,
            spoiler: null,
          },
          {
            kind: 'audio',
            filename: 'memo.ogg',
            caption: null,
            source: 'mxc://example.org/memo',
            mime: 'audio/ogg',
            duration_ms: 4000,
            waveform: [0, 1],
          },
          {
            kind: 'file',
            filename: 'archive.zip',
            caption: null,
            source: 'mxc://example.org/archive',
            mime: 'application/zip',
            size: 1_500_000,
          },
        ],
      }),
      canRedactOthers: false,
    },
  });
  await tick();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await tick();

  expect(screen.getByRole('button', { name: 'Open the beach' })).toBeInTheDocument();
  expect(screen.getByText('the beach')).toHaveClass('item-caption');
  expect(document.querySelector('.gallery .voice-message-player')).toBeInTheDocument();
  expect(screen.getByText('1.5 MB')).toHaveClass('media-file-size');
});

test('hides a spoilered gallery item until it is revealed', async () => {
  render(MessageBody, {
    props: {
      item: item({
        kind: 'gallery',
        body: '',
        html: '',
        items: ['one', 'two'].map((name) => ({
          kind: 'image' as const,
          filename: `${name}.png`,
          caption: null,
          source: `mxc://example.org/${name}`,
          mime: 'image/png',
          width: 100,
          height: 100,
          size: null,
          blurhash: null,
          thumbnail: null,
          spoiler: name === 'two' ? 'sunburn' : null,
        })),
      }),
      canRedactOthers: false,
    },
  });
  await tick();

  expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(1);

  await userEvent.click(screen.getByRole('button', { name: 'Reveal two.png' }));

  expect(screen.getAllByRole('button', { name: /^Open / })).toHaveLength(2);
});

test('gallery captions and images agree when an image leaves and returns to its slot', async () => {
  const image = {
    kind: 'image' as const,
    filename: 'ending.png',
    caption: 'Secret ending',
    source: 'mxc://example.org/gallery-ending',
    mime: 'image/png',
    width: 100,
    height: 100,
    size: null,
    blurhash: null,
    thumbnail: null,
    spoiler: 'Ending',
  };
  const gallery = (source: string) =>
    item({ kind: 'gallery', body: '', html: '', items: [{ ...image, source }] });
  const view = render(MessageBody, {
    item: gallery(image.source),
    canRedactOthers: false,
  });

  await userEvent.click(screen.getByRole('button', { name: 'Reveal ending.png' }));
  await view.rerender({ item: gallery('mxc://example.org/replacement') });
  expect(document.querySelector('.spoilerable-media')).toHaveClass('spoilered');
  expect(screen.queryByText('Secret ending')).not.toBeInTheDocument();

  await view.rerender({ item: gallery(image.source) });
  expect(document.querySelector('.spoilerable-media')).not.toHaveClass('spoilered');
  expect(screen.getByText('Secret ending')).toBeInTheDocument();
});

test('keeps an image filename hidden without the alt-text preference', async () => {
  render(MessageBody, {
    props: {
      item: item({
        kind: 'image',
        filename: 'photo.png',
        caption: null,
        html: null,
        source: 'mxc://example.org/photo',
        mime: 'image/png',
        width: null,
        height: null,
        size: null,
        blurhash: null,
        thumbnail: null,
        spoiler: null,
        animated: null,
      }),
      canRedactOthers: false,
    },
  });
  await tick();

  expect(screen.queryByText('photo.png')).not.toBeInTheDocument();
});

test.each(['image', 'video', 'audio', 'file'] as const)(
  'renders a plain caption under a %s attachment',
  async (kind) => {
    const content = { ...attachment(kind), html: null } as TimelineItemContentView;
    render(MessageBody, { item: item(content), canRedactOthers: false });
    await tick();

    expect(screen.getByText('caption')).toHaveClass('body');
  }
);

test.each(['image', 'video', 'audio', 'file'] as const)(
  'never reads a %s filename as a caption',
  async (kind) => {
    const content = { ...attachment(kind), html: null, caption: null } as TimelineItemContentView;
    render(MessageBody, { item: item(content), canRedactOthers: false });
    await tick();

    expect(document.querySelector('.body')).not.toBeInTheDocument();
  }
);

test.each(['javascript:alert(document.domain)', 'data:text/html,unsafe', 'geo:invalid'])(
  'does not turn an invalid location into a navigable link: %s',
  async (geoUri) => {
    render(MessageBody, {
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
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText(/Here/)).toBeInTheDocument();
  }
);

test('opens a valid location using validated coordinates', async () => {
  render(MessageBody, {
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
  expect(screen.getByRole('link')).toHaveAttribute('href', 'geo:48.8,2.3');
});

test('hides video spoilers and their captions until revealed', async () => {
  const content = { ...attachment('video'), spoiler: 'Ending' } as TimelineItemContentView;
  render(MessageBody, { item: item(content), canRedactOthers: false });
  await tick();
  expect(core.commands.fetchMedia).not.toHaveBeenCalled();
  expect(document.querySelector('video, .formatted-body')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /Ending/ }));
  expect(document.querySelector('.formatted-body')).toBeInTheDocument();
});

test('blurs a spoilered image and lets it be revealed again', async () => {
  const onOpenMedia = vi.fn();
  const content = { ...attachment('image'), spoiler: 'Ending' } as TimelineItemContentView;
  render(MessageBody, { item: item(content), canRedactOthers: false, onOpenMedia });
  await tick();

  const media = document.querySelector('.spoilerable-media');
  expect(media).toHaveClass('spoilered');
  expect(document.querySelector('.media-image')).toBeInTheDocument();
  expect(document.querySelector('.formatted-body')).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Reveal photo.png' }));
  expect(media).not.toHaveClass('spoilered');
  expect(document.querySelector('.formatted-body')).toBeInTheDocument();
  expect(onOpenMedia).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: 'Open caption' }));
  expect(onOpenMedia).toHaveBeenCalledWith('$item');

  await userEvent.click(screen.getByRole('button', { name: 'Hide photo.png' }));
  expect(media).toHaveClass('spoilered');
});

test('lets an ordinary image be hidden locally', async () => {
  render(MessageBody, { item: item(attachment('image')), canRedactOthers: false });
  await tick();

  const media = document.querySelector('.spoilerable-media');
  expect(media).not.toHaveClass('spoilered');

  await userEvent.click(screen.getByRole('button', { name: 'Hide photo.png' }));
  expect(media).toHaveClass('spoilered');
  expect(screen.getByRole('button', { name: 'Reveal photo.png' })).toBeInTheDocument();
});

test('a recycled image does not inherit the previous image reveal or caption state', async () => {
  const content = { ...attachment('image'), spoiler: 'Ending' } as TimelineItemContentView;
  const view = render(MessageBody, { item: item(content), canRedactOthers: false });
  await userEvent.click(screen.getByRole('button', { name: 'Reveal photo.png' }));

  const next = {
    ...content,
    source: 'mxc://example.org/another-spoiler',
  } as TimelineItemContentView;
  await view.rerender({ item: { ...item(next), id: 'next', event_id: '$next' } });

  expect(document.querySelector('.spoilerable-media')).toHaveClass('spoilered');
  expect(document.querySelector('.formatted-body')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reveal photo.png' })).toBeInTheDocument();
});

test('a sticker can be hidden without opening its viewer', async () => {
  const onOpenMedia = vi.fn();
  render(MessageBody, {
    item: item({
      kind: 'sticker',
      body: 'Cat sticker',
      source: 'mxc://example.org/sticker',
      mime: 'image/png',
      width: 128,
      height: 128,
    }),
    canRedactOthers: false,
    onOpenMedia,
  });

  await userEvent.click(screen.getByRole('button', { name: 'Hide Cat sticker' }));
  expect(document.querySelector('.spoilerable-media')).toHaveClass('spoilered');
  expect(onOpenMedia).not.toHaveBeenCalled();
});

test('live location expires without another SDK update and keeps its last known coordinates', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const instance = render(MessageBody, {
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
  expect(screen.getByText(/Sharing live location/)).toBeInTheDocument();
  await vi.advanceTimersByTimeAsync(1_000);
  await tick();
  expect(screen.getByText(/Location sharing ended/)).toBeInTheDocument();
  expect(screen.getByRole('link')).toHaveAttribute('href', 'geo:48.8,2.3');
  instance.unmount();
  vi.useRealTimers();
});

test('a deleted message keeps its reason', async () => {
  render(MessageBody, { item: item({ kind: 'redacted', reason: 'spam' }), canRedactOthers: false });
  await tick();

  expect(screen.getByText(/spam/)).toBeInTheDocument();
});

test.each(['above', 'below', 'inline'] as const)(
  'places an attachment caption %s the media',
  async (position) => {
    setPreference('captionPosition', position);
    render(MessageBody, { item: item(attachment('image')), canRedactOthers: false });
    await tick();

    const wrapper = document.querySelector('.captioned');
    expect(wrapper).toHaveClass(`caption-${position}`);
    expect(wrapper?.querySelector('.formatted-body')).toBeInTheDocument();
  }
);

test.each(['image', 'file'] as const)('a hidden caption is not rendered for %s', async (kind) => {
  setPreference('captionPosition', 'hidden');
  render(MessageBody, { item: item(attachment(kind)), canRedactOthers: false });
  await tick();

  expect(screen.queryByText('caption')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: '@ana' })).not.toBeInTheDocument();
});

test('media is held behind a prompt where the media preview setting says so (MSC4278)', async () => {
  mediaPreviewSettings.global = { media_previews: 'private' };
  const user = userEvent.setup();
  render(MessageBodyMediaHarness, {
    props: { item: item(attachment('image')), joinRule: 'public' },
  });

  await user.click(screen.getByRole('button', { name: 'Show media' }));

  expect(screen.queryByRole('button', { name: 'Show media' })).not.toBeInTheDocument();
  mediaPreviewSettings.global = {};
});

test('media shows at once in a private room under the private setting', () => {
  mediaPreviewSettings.global = { media_previews: 'private' };
  render(MessageBodyMediaHarness, {
    props: { item: item(attachment('image')), joinRule: 'invite' },
  });

  expect(screen.queryByRole('button', { name: 'Show media' })).not.toBeInTheDocument();
  mediaPreviewSettings.global = {};
});
