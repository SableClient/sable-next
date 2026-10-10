import { afterEach, expect, test, vi } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';

import en from '../../../../locales/en.json' with { type: 'json' };
import { render } from 'vitest-browser-svelte';

import type { ProfileView, TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [] }),
}));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));
vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { core } from '#lib/core/__mocks__/context.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';

declare module 'vitest/browser' {
  interface BrowserCommands {
    emulateColorScheme: (scheme: 'light' | 'dark') => Promise<void>;
  }
}

afterEach(async () => {
  document.body.removeAttribute('style');
  await commands.emulateColorScheme('light');
  await page.viewport(414, 800);
  setPreference('replyPreviewStyle', 'connected');
});

const profile: ProfileView = {
  user_id: '@alice:example.test',
  display_name: 'Alice',
  avatar_url: null,
  bio: null,
  hero_color: null,
  hero_brightness: null,
  banner_url: null,
  status: null,
  pronouns: [],
  timezone: null,
  name_color_light: '#b0306a',
  name_color_dark: '#f09ac0',
  animal: null,
  extra: [],
  supporter_awards: null,
  legacy_fields: [],
};

function message(id: string, sender: string, senderName: string): TimelineItemView {
  return {
    id,
    event_id: `$${id}:example.test`,
    transaction_id: null,
    send_state: null,
    sender,
    sender_name: senderName,
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: `Message from ${senderName}`,
      html: `Message from ${senderName}`,
      emote: false,
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
  };
}

function replyToAlice(id: string, sender: string, senderName: string): TimelineItemView {
  return {
    ...message(id, sender, senderName),
    in_reply_to: {
      event_id: '$general-1:example.test',
      sender: '@alice:example.test',
      sender_mentioned: false,
      sender_name: 'Alice',
      body: 'General message 1',
    },
  };
}

function mountItem(
  item: TimelineItemView,
  layout: 'modern' | 'compact' = 'modern',
  extra: Record<string, unknown> = {}
) {
  core.userProfile.mockImplementation((userId: string) =>
    Promise.resolve(userId === profile.user_id ? profile : { ...profile, user_id: userId })
  );
  return render(TimelineItemHarness, {
    core,
    item: { item, collapsed: false, layout, ...extra },
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`a reply names its sender in the colour of their messages on the ${scheme} theme`, async () => {
    await commands.emulateColorScheme(scheme);
    await mountItem(message('alice-says', '@alice:example.test', 'Alice'));
    await mountItem(replyToAlice('reply-to-alice', '@e2e:example.test', 'E2E User'));

    await expect
      .poll(() =>
        document.querySelector('.reply-preview .reply-name, .reply-connected .reply-name')
      )
      .toHaveClass('tinted');
    const reply = document.querySelector('.reply-name');
    const header = document.querySelector('.sender-identity-name.tinted');
    if (!reply || !header) throw new Error('the reply or the header is not rendered');
    expect(getComputedStyle(reply).color).toBe(getComputedStyle(header).color);
  });
}

test('a compact connected reply keeps its connector clear of the name gutter', async () => {
  setPreference('replyPreviewStyle', 'connected');
  await mountItem(replyToAlice('compact-reply', '@bob:example.test', 'Bob'), 'compact');

  const row = document.querySelector('.message');
  const gutter = row?.querySelector('.compact-gutter');
  const reply = row?.querySelector('.reply-connected');
  if (!gutter || !reply) throw new Error('missing compact reply parts');
  const connectorLeft =
    reply.getBoundingClientRect().left + parseFloat(getComputedStyle(reply, '::before').left);
  expect(connectorLeft).toBeGreaterThanOrEqual(gutter.getBoundingClientRect().right);
});

test('a mobile connected reply aligns its preview text with the sender name', async () => {
  await page.viewport(390, 844);
  setPreference('replyPreviewStyle', 'connected');
  await mountItem(replyToAlice('aligned-reply', '@bob:example.test', 'Bob'));
  await document.fonts.ready;

  const reply = document.querySelector('.reply-connected');
  const name = reply?.querySelector('.reply-name');
  const body = reply?.querySelector('.reply-body');
  if (!name || !body) throw new Error('Missing reply text');
  const range = document.createRange();
  range.selectNodeContents(name);
  const nameTop = range.getBoundingClientRect().top;
  range.selectNodeContents(body);
  expect(Math.abs(nameTop - range.getBoundingClientRect().top)).toBeLessThanOrEqual(1);
});

async function parkPointer(): Promise<void> {
  const spot = document.createElement('div');
  Object.assign(spot.style, {
    position: 'fixed',
    right: '0',
    bottom: '0',
    width: '8px',
    height: '8px',
  });
  document.body.append(spot);
  await userEvent.hover(spot);
  spot.remove();
}

async function widePng(): Promise<Uint8Array<ArrayBuffer>> {
  const canvas = new OffscreenCanvas(600, 40);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No canvas context');
  context.fillStyle = '#3366cc';
  context.fillRect(0, 0, 600, 40);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

function layers(root: Element): number[][] {
  const frame = root.getBoundingClientRect();
  return [...root.querySelectorAll('.media-image')].map((layer) => {
    const box = layer.getBoundingClientRect();
    return [
      box.left - frame.left,
      box.top - frame.top,
      box.width - frame.width,
      box.height - frame.height,
    ].map(Math.round);
  });
}

test('an avatar picture fills its frame exactly, however wide the image', async () => {
  await parkPointer();
  Object.assign(core, { fetchMedia: vi.fn(widePng) });
  await mountItem({
    ...message('wide', '@alice:example.test', 'Alice'),
    sender_avatar: 'mxc://example.test/wide-avatar',
  });

  await expect.poll(() => document.querySelector('.avatar-root img')).not.toBeNull();
  const frame = document.querySelector('.avatar-root:has(img)');
  if (!frame) throw new Error('the avatar frame is not rendered');
  expect(layers(frame)).toEqual([[0, 0, 0, 0]]);
});

test('the hover animation stacks over the still picture inside the frame', async () => {
  await parkPointer();
  Object.assign(core, { fetchMedia: vi.fn(widePng) });
  await mountItem({
    ...message('hover', '@hover:example.test', 'Hover'),
    sender_avatar: 'mxc://example.test/wide-avatar',
  });

  await expect.poll(() => document.querySelector('.avatar-root img')).not.toBeNull();
  const frame = document.querySelector<HTMLElement>('.avatar-root:has(img)');
  const row = document.querySelector<HTMLElement>('.message');
  if (!frame || !row) throw new Error('the row is not rendered');
  const width = frame.getBoundingClientRect().width;

  await userEvent.hover(row);
  await expect.poll(() => frame.querySelectorAll('.media-image').length).toBe(2);

  expect(frame.getBoundingClientRect().width).toBe(width);
  expect(layers(frame)).toEqual([
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
});

test('right-clicking the same message again reopens the menu at the pointer', async () => {
  await page.viewport(900, 600);
  const screen = await mountItem(message('menu-2', '@alice:example.test', 'Alice'));
  const row = document.querySelector<HTMLElement>('article.message');
  if (!row) throw new Error('the message row is not rendered');
  const box = row.getBoundingClientRect();
  const menu = () => document.querySelectorAll('.message-menu');
  const menuLeft = () => document.querySelector('.message-menu')?.getBoundingClientRect().x ?? 0;

  await userEvent.click(screen.getByRole('article').first(), {
    button: 'right',
    position: { x: 20, y: box.height / 2 },
  });
  await expect.poll(() => menu().length).toBe(1);
  const first = menuLeft();

  await userEvent.click(screen.getByRole('article').first(), {
    button: 'right',
    position: { x: box.width - 20, y: box.height / 2 },
  });
  await expect.poll(menuLeft).toBeGreaterThan(first + 100);
  expect(menu()).toHaveLength(1);
});

test('a hover action still fires when the row loses hover and focus mid-press', async () => {
  await page.viewport(1280, 700);
  document.body.style.paddingTop = '120px';
  const onReply = vi.fn();
  const screen = await mountItem(message('menu-2', '@alice:example.test', 'Alice'), 'modern', {
    onReply,
  });
  const row = document.querySelector<HTMLElement>('article.message');
  if (!row) throw new Error('the message row is not rendered');
  await userEvent.hover(row);
  const reply = screen.getByRole('button', { name: en.timeline.reply, exact: true });
  const button = reply.element() as HTMLElement;
  await userEvent.hover(button);
  button.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      pointerType: 'mouse',
      isPrimary: true,
      buttons: 1,
    })
  );
  button.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  row.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse', buttons: 1 }));
  button.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, pointerType: 'mouse', isPrimary: true })
  );
  button.click();

  await expect.poll(() => onReply.mock.calls.length).toBe(1);
});

function galleryItem(id: string, items: { filename: string; width: number; height: number }[]) {
  return {
    ...message(id, '@alice:example.test', 'Alice'),
    content: {
      kind: 'gallery',
      body: '',
      html: '',
      items: items.map(({ filename, width, height }) => ({
        kind: 'image',
        filename,
        caption: null,
        source: JSON.stringify({ Plain: 'mxc://example.test/history-image' }),
        mime: 'image/png',
        width,
        height,
        size: null,
        blurhash: null,
        thumbnail: null,
        spoiler: null,
      })),
    },
  } as TimelineItemView;
}

for (const [name, width] of [
  ['desktop', 1280],
  ['mobile', 390],
] as const) {
  test(`a forwarded gallery keeps its label above the media on ${name}`, async () => {
    await page.viewport(width, 900);
    Object.assign(core, { fetchMedia: vi.fn(widePng) });
    await mountItem({
      ...galleryItem('forwarded', [
        { filename: 'one', width: 800, height: 600 },
        { filename: 'two', width: 800, height: 600 },
      ]),
      forwarded: { room_id: '!random:example.test', event_id: '$original', timestamp: null },
      read_by: ['@bob:example.test'],
    });

    await expect.poll(() => document.querySelector('.gallery img')).not.toBeNull();
    const label = document.querySelector('.forwarded')?.getBoundingClientRect();
    const gallery = document.querySelector('.gallery')?.getBoundingClientRect();
    if (!label || !gallery) throw new Error('forwarded gallery missing');
    expect(gallery.y).toBeGreaterThanOrEqual(label.y + label.height);
  });
}

test('an edited message keeps its marker on the body line', async () => {
  await page.viewport(1280, 900);
  const plain = message('marker-plain', '@alice:example.test', 'Alice');
  const edited = message('marker-edited', '@alice:example.test', 'Alice');
  if (edited.content.kind !== 'message') throw new Error('expected a message');
  edited.content = { ...edited.content, edited: true };
  await mountItem(plain);
  await mountItem(edited);

  const heights = [...document.querySelectorAll('article.message')].map(
    (row) => row.getBoundingClientRect().height
  );
  expect(heights).toHaveLength(2);
  expect(heights[1]).toBeCloseTo(heights[0] ?? 0, 0);
  expect(document.querySelectorAll('.edited, [class*="edited"]').length).toBeGreaterThan(0);
});
