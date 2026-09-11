// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

const core = vi.hoisted(() => {
  const stub = {
    fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
    userProfile: vi.fn().mockRejectedValue(new Error('profile unavailable')),
    pinnedEvents: vi.fn(() => Promise.resolve<string[]>([])),
    setPinned: vi.fn(() => Promise.resolve<string[]>([])),
    bookmarks: vi.fn(() => Promise.resolve([])),
    setBookmark: vi.fn(() => Promise.resolve(false)),
  };

  return Object.assign(stub, { commands: stub });
});

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null }) };
});

import { setPreference } from '#lib/settings/preferences.svelte.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';

afterEach(() => {
  document.body.replaceChildren();
  core.userProfile.mockReset();
  core.userProfile.mockRejectedValue(new Error('profile unavailable'));
});

function item(emote: boolean): TimelineItemView {
  return {
    id: 'item',
    event_id: '$item',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: { kind: 'message', body: 'waves', html: 'waves', emote, notice: false, edited: false },
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

function imageItem(body = 'photo.png'): TimelineItemView {
  return {
    ...item(false),
    content: {
      kind: 'image',
      html: null,
      body,
      source: 'mxc://example.org/photo',
      filename: 'photo.png',
      mime: 'image/png',
      width: 800,
      height: 600,
      size: null,
      blurhash: null,
      spoiler: null,
    },
  };
}

test('renders placeholders through the standard message layout', async () => {
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: {
      core: core.commands,
      item: {
        item: item(false),
        collapsed: false,
        placeholder: true,
        placeholderCharacters: 24,
      },
    },
  });
  await tick();

  const message = document.querySelector('.message.placeholder-message');
  expect(message).toBeInstanceOf(HTMLElement);
  expect(message?.querySelector('.avatar-root.message-avatar')).toBeInstanceOf(HTMLElement);
  expect(
    message?.querySelector<HTMLElement>('.message-content .formatted-body .placeholder-copy')
      ?.textContent
  ).toBe('x'.repeat(24));
  expect(message?.getAttribute('aria-hidden')).toBe('true');

  await unmount(instance);
});

test('reads an emote as one sentence, with the name only in the action', async () => {
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(true), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('.emote')?.textContent.trim()).toBe('* Alice waves');
  expect(document.querySelector('header .sender')).toBeNull();
  expect(document.querySelector('header time')).not.toBeNull();
  await unmount(instance);
});

test('badges a message with its own readers, and only in that placement', async () => {
  const read = { ...item(false), read_by: ['@alice:example.org', '@bob:example.org'] };
  const members = [
    {
      user_id: '@bob:example.org',
      display_name: 'Bob',
      avatar_url: null,
      power_level: 0,
      membership: 'join' as const,
      member_ts: null,
      kicked: false,
    },
  ];
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: {
      core: core.commands,
      item: { item: read, collapsed: false, members, currentUserId: '@alice:example.org' },
    },
  });
  await tick();

  const badge = document.querySelector('.read-receipt-stack');
  expect(badge?.getAttribute('title')).toBe('Bob');

  setPreference('readReceiptPlacement', 'room');
  await tick();
  expect(document.querySelector('.read-receipt-stack')).toBeNull();

  setPreference('readReceiptPlacement', 'message');
  await tick();
  setPreference('hideReadReceipts', true);
  await tick();
  expect(document.querySelector('.read-receipt-stack')).toBeNull();

  setPreference('hideReadReceipts', false);
  await unmount(instance);
});

test('keeps the sender header for an ordinary message', async () => {
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('header .sender')?.textContent).toBe('Alice');
  expect(document.querySelector('.emote')).toBeNull();
  await unmount(instance);
});

test('clicking the sender name mentions the account behind it', async () => {
  const onMentionUser = vi.fn();
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: {
      core: core.commands,
      item: {
        item: {
          ...item(false),
          per_message_profile: {
            id: 'kris',
            display_name: 'Kris',
            avatar_url: null,
            pronouns: [],
            color_on_light: null,
            color_on_dark: null,
            has_fallback: false,
          },
        },
        collapsed: false,
        onMentionUser,
      },
    },
  });
  await tick();

  document.querySelector<HTMLButtonElement>('header button.sender')?.click();

  expect(onMentionUser).toHaveBeenCalledWith('@alice:example.org', 'Alice');
  await unmount(instance);
});

test('edits an own image caption without dropping its media details', async () => {
  const onEdit = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array());
  const image = {
    ...imageItem(),
    is_own: true,
    content: { ...imageItem().content, body: 'caption' },
  };
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: image, collapsed: false, onEdit } },
  });
  await tick();

  document
    .querySelector('.message')
    ?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
  await tick();
  document.querySelector<HTMLButtonElement>('.message-actions button')?.click();

  expect(onEdit).toHaveBeenCalledWith('$item', 'caption', null, true);
  await unmount(instance);
});

test('drops the right-hand side of a bubble when own alignment is off', async () => {
  const own = { ...item(false), is_own: true };
  for (const [alignOwn, expected] of [
    [true, true],
    [false, false],
  ] as const) {
    const instance = mount(TimelineItemHarness, {
      target: document.body,
      props: {
        core: core.commands,
        item: { item: own, collapsed: false, layout: 'bubble', alignOwn },
      },
    });
    await tick();

    expect(document.querySelector('.message.own')?.classList.contains('align-own')).toBe(expected);

    await unmount(instance);
  }
});

test('wraps non-text messages in a bubble in bubble layout', async () => {
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: {
      core: core.commands,
      item: {
        item: imageItem('A caption'),
        collapsed: false,
        layout: 'bubble',
      },
    },
  });
  await tick();

  expect(document.querySelector('.message.layout-bubble .content-bubble')).toBeInstanceOf(
    HTMLElement
  );

  await unmount(instance);
});

test('uses the sender profile name color in every message layout', async () => {
  core.userProfile.mockResolvedValue({
    name_color_light: '#4f7a3a',
    name_color_dark: '#9fd07c',
  });
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false } },
  });
  await tick();

  const name = document.querySelector<HTMLElement>('.sender');
  expect(name?.classList.contains('tinted')).toBe(true);
  expect(
    document.querySelector<HTMLElement>('.message')?.style.getPropertyValue('--name-color-on-light')
  ).toBe('#4f7a3a');
  expect(
    document.querySelector<HTMLElement>('.message')?.style.getPropertyValue('--name-color-on-dark')
  ).toBe('#9fd07c');
  await unmount(instance);
});

test('does not mount hidden message dialogs', async () => {
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('.sheet-list')).toBeNull();
  expect(document.querySelector('.delete')).toBeNull();
  expect(document.querySelector('.reactions-dialog')).toBeNull();
  expect(document.querySelector('.receipts-dialog')).toBeNull();
  await unmount(instance);
});

test('opens an image from a mobile pointer interaction', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onOpenMedia = vi.fn();
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: imageItem(), collapsed: false, onOpenMedia } },
  });
  await tick();
  const image = document.querySelector<HTMLButtonElement>('.media-image');
  if (!image) throw new Error('media trigger was not rendered');

  image.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  image.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
  image.click();

  expect(onOpenMedia).toHaveBeenCalledWith('$item');
  await unmount(instance);
});

test('opens a per-message profile avatar through viewer callback', async () => {
  const onPersonaAvatarClick = vi.fn();
  const persona = {
    ...item(false),
    per_message_profile: {
      id: 'kris',
      display_name: 'Kris',
      avatar_url: 'mxc://example.org/kris',
      pronouns: [],
      color_on_light: null,
      color_on_dark: null,
      has_fallback: false,
    },
  };
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: {
      core: core.commands,
      item: { item: persona, collapsed: false, layout: 'modern', onPersonaAvatarClick },
    },
  });
  await tick();

  const profileTrigger = document.querySelector<HTMLButtonElement>('.avatar-button');
  if (!profileTrigger) throw new Error('persona profile trigger was not rendered');
  profileTrigger.click();
  await tick();

  const avatarButton = document.querySelector<HTMLButtonElement>('.profile-card-avatar-button');
  if (!avatarButton) throw new Error('persona avatar button was not rendered');
  avatarButton.click();
  await tick();

  expect(onPersonaAvatarClick).toHaveBeenCalledWith('mxc://example.org/kris', 'Kris');
  expect(
    profileTrigger.getAttribute('aria-expanded') ?? profileTrigger.getAttribute('data-state')
  ).toMatch(/false|closed/);
  await unmount(instance);
});

test('a per-message profile takes the sender position and names the account behind it', async () => {
  core.userProfile.mockResolvedValue({
    name_color_light: '#2244aa',
    name_color_dark: '#88aaff',
  });
  const onSenderProfile = vi.fn();
  const persona = {
    ...item(false),
    per_message_profile: {
      id: 'kris',
      display_name: 'Kris',
      avatar_url: null,
      pronouns: [{ summary: 'they/them', language: null }],
      color_on_light: '#4f7a3a',
      color_on_dark: '#9fd07c',
      has_fallback: false,
    },
  };
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: {
      core: core.commands,
      item: { item: persona, collapsed: false, onSenderProfile },
    },
  });
  await tick();

  expect(document.querySelector('header .sender')?.textContent.trim()).toBe('Kris');
  expect(document.querySelector('header .sender-identity-pronoun')?.textContent).toBe('they/them');

  const via = document.querySelector('header .sender-identity-via');
  expect(via?.textContent).toContain('Alice');
  expect(via?.textContent).not.toContain('@alice:example.org');

  const viaButton = via?.querySelector<HTMLButtonElement>('.name-button');
  if (!viaButton) throw new Error('the account behind the persona was not a button');
  viaButton.click();
  expect(onSenderProfile).toHaveBeenCalledWith('@alice:example.org', viaButton);
  await unmount(instance);
});

test('without a persona the hover-only via keeps the account MXID', async () => {
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false } },
  });
  await tick();

  const via = document.querySelector('header .via');
  expect(via?.className).toContain('via-hidden');
  expect(via?.textContent).toContain('@alice:example.org');
  await unmount(instance);
});

test('provides a formatted reaction attribution tooltip', async () => {
  const reacted = {
    ...item(false),
    reactions: [{ key: '👍', senders: ['@alice:example.org'] }],
  };
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: {
      core,
      item: {
        item: reacted,
        collapsed: false,
        members: [
          {
            user_id: '@alice:example.org',
            display_name: 'Alice',
            avatar_url: null,
            power_level: 0,
            membership: 'join',
            member_ts: null,
            kicked: false,
          },
        ],
      },
    },
  });
  await tick();

  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  if (!reaction) throw new Error('reaction was not rendered');
  vi.useFakeTimers();
  reaction.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
  await vi.advanceTimersByTimeAsync(400);
  await tick();

  expect(document.querySelector('.reaction-tooltip')?.textContent).toBe('Alice reacted with 👍');
  vi.useRealTimers();
  await unmount(instance);
});

test('mounts the action bar on hover and keeps it while its menu is open', async () => {
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: {
      core: core.commands,
      item: { item: item(false), collapsed: false, onReply: vi.fn(), onCopyLink: vi.fn() },
    },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');
  expect(document.querySelector('.message-actions')).toBeNull();

  message.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
  await tick();
  expect(document.querySelector('.message-actions')).not.toBeNull();

  document
    .querySelector<HTMLButtonElement>('.message-actions [data-dropdown-menu-trigger]')
    ?.click();
  await tick();
  message.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, pointerType: 'mouse' }));
  await tick();
  expect(document.querySelector('.message-actions')).not.toBeNull();

  await unmount(instance);
});

test('opens message actions on right click', async () => {
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false, onReply: vi.fn() } },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  message.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick();

  expect(document.querySelector('.menu-surface')?.textContent).toContain('Reply');
  await unmount(instance);
});

test('long pressing a reaction opens its people list without toggling it', async () => {
  vi.useFakeTimers();
  const onToggleReaction = vi.fn();
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: {
      core,
      item: {
        item: { ...item(false), reactions: [{ key: '👍', senders: ['@alice:example.org'] }] },
        collapsed: false,
        onToggleReaction,
        members: [
          {
            user_id: '@alice:example.org',
            display_name: 'Alice',
            avatar_url: null,
            power_level: 0,
            membership: 'join',
            member_ts: null,
            kicked: false,
          },
        ],
      },
    },
  });
  await tick();
  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  if (!reaction) throw new Error('reaction was not rendered');

  reaction.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  await vi.advanceTimersByTimeAsync(450);
  await tick();
  reaction.click();

  expect(document.querySelector('.reactions-dialog')?.textContent).toContain('Alice');
  expect(document.querySelector('.sheet-list')).toBeNull();
  expect(onToggleReaction).not.toHaveBeenCalled();
  vi.useRealTimers();
  await unmount(instance);
});

test('renders a redacted row and a worded state change without throwing', async () => {
  for (const content of [
    { kind: 'redacted', reason: null } as const,
    {
      kind: 'state_event',
      event_type: 'm.room.topic',
      state_key: '',
      content: null,
      change: { kind: 'room_topic', topic: 'what we do' },
    } as const,
    {
      kind: 'state_event',
      event_type: 'm.room.power_levels',
      state_key: '',
      content: { users: {} },
      change: null,
    } as const,
  ]) {
    const target = document.createElement('div');
    document.body.append(target);
    const component = mount(TimelineItemHarness, {
      target,
      props: { core: core.commands, item: { item: { ...item(false), content }, collapsed: false } },
    });
    await tick();

    expect(target.textContent.trim(), `${content.kind} rendered empty`).not.toBe('');
    void unmount(component);
    target.remove();
  }
});

test('shows every pronoun set from the sender account profile', async () => {
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: null },
      { summary: 'they/them', language: null },
    ],
  });
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(2);
  });
  await unmount(instance);
});

test('shows only the sets tagged with the reader language', async () => {
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: 'en' },
      { summary: 'elle', language: 'fr' },
    ],
  });
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toBe('she/her');
  });
  await unmount(instance);
});

test('shows every set once the language filter is switched off', async () => {
  setPreference('filterPronounsByLanguage', false);
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: 'en' },
      { summary: 'elle', language: 'fr' },
    ],
  });
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(2);
  });
  setPreference('filterPronounsByLanguage', true);
  await vi.waitFor(() => {
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(1);
  });
  await unmount(instance);
});

test('caps the pills at three and counts the rest', async () => {
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: 'en' },
      { summary: 'they/them', language: 'en' },
      { summary: 'he/him', language: 'en' },
      { summary: 'it/its', language: 'en' },
    ],
  });
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect(pills).toHaveLength(4);
    expect(pills[3].textContent).toBe('+1');
    expect(pills[3].getAttribute('title')).toBe('it/its (en)');
  });
  await unmount(instance);
});

test('a touch long press opens the sheet without also opening the context menu', async () => {
  vi.useFakeTimers();
  const instance = mount(TimelineItemHarness, {
    target: document.body,
    props: { core: core.commands, item: { item: item(false), collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  const article = document.querySelector('article.message');
  expect(article).not.toBeNull();

  article?.dispatchEvent(
    new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true, clientX: 0, clientY: 0 })
  );
  await vi.advanceTimersByTimeAsync(1000);
  await tick();

  const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  article?.dispatchEvent(native);
  await tick();

  expect(native.defaultPrevented).toBe(true);
  expect(document.querySelectorAll('[data-context-menu-content]')).toHaveLength(0);
  expect(document.querySelector('[data-dialog-content]')).not.toBeNull();

  await unmount(instance);
  vi.useRealTimers();
});
