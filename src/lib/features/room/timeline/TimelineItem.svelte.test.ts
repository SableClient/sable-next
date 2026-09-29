// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent, TimelineItemView, UrlPreviewView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { LONG_PRESS_MS } from '#lib/ui/long-press.svelte.js';
import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  pinnedEvents: vi.fn(() => Promise.resolve<string[]>([])),
  setPinned: vi.fn(() => Promise.resolve<string[]>([])),
  bookmarks: vi.fn(() => Promise.resolve([])),
  setBookmark: vi.fn(() => Promise.resolve(false)),
  urlPreview: vi.fn((url: string): Promise<UrlPreviewView> =>
    Promise.resolve({
      url,
      title: url,
      description: null,
      site_name: null,
      image: null,
      image_mime: null,
      image_width: null,
      image_height: null,
    })
  ),
});

const { saveBytes } = vi.hoisted(() => ({
  saveBytes: vi.fn(() => Promise.resolve('saved' as const)),
}));

vi.mock('#lib/platform/files.js', async () => ({
  ...(await vi.importActual<typeof import('#lib/platform/files.js')>('#lib/platform/files.js')),
  saveBytes,
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

import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';
import { senderColor } from './timeline-format';

const user = userEvent.setup({ delay: null });

async function press(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to press');
  await user.click(element);
}

async function openMenu(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to open a menu on');
  await user.pointer({ keys: '[MouseRight]', target: element });
}

async function hover(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to hover');
  await user.hover(element);
}

const menuItem = (name: string) => screen.getByRole('menuitem', { name: new RegExp(name) });
const menuLabels = () => screen.getAllByRole('menuitem').map((row) => row.textContent.trim());

afterEach(() => {
  document.body.replaceChildren();
  setPreference('replyPreviewStyle', 'connected');
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
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
  };
}

function imageItem(body = 'photo.png'): TimelineItemView {
  return {
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
  };
}

function replyItem(
  body = 'A reply with enough text to show how the preview is rendered.',
  mention: TimelineItemView['mention'] = 'none',
  isMentioned = false
): TimelineItemView {
  return {
    ...item(false),
    mention,
    in_reply_to: {
      event_id: '$original',
      sender: '@bob:example.org',
      sender_mentioned: isMentioned,
      sender_name: 'Bob',
      body,
    },
  };
}

test('places a connected reply preview above the sender header', async () => {
  setPreference('replyPreviewStyle', 'connected');
  const onJumpToEvent = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: replyItem(), collapsed: false, onJumpToEvent },
    },
  });
  await tick();

  const reply = document.querySelector<HTMLButtonElement>('.message-content > .reply-connected');
  const message = document.querySelector('.message');
  expect(reply).toBeInstanceOf(HTMLButtonElement);
  expect(message?.classList.contains('has-connected-reply')).toBe(true);
  expect(message?.querySelector(':scope > .message-avatar')).not.toBeNull();
  expect(reply?.nextElementSibling?.tagName).toBe('HEADER');
  const name = reply?.querySelector<HTMLElement>('.reply-name');
  expect(name?.style.color).toBe(senderColor('@bob:example.org'));
  expect(name?.textContent).toBe('Bob');
  await press(reply);
  expect(onJumpToEvent).toHaveBeenCalledWith('$original');
});

test.each(['connected', 'compact', 'expanded'] as const)(
  'separates reply names from bodies in %s previews',
  async (replyPreviewStyle) => {
    setPreference('replyPreviewStyle', replyPreviewStyle);
    render(TimelineItemHarness, {
      props: { core, item: { item: replyItem(), collapsed: false } },
    });
    await tick();

    const copy = document.querySelector('.reply-preview .reply-copy');
    expect(copy?.querySelector('.reply-name + .reply-body')).toBeInstanceOf(HTMLElement);
  }
);

test.each(['connected', 'compact', 'expanded'] as const)(
  'marks a pinged reply target with an at sign in %s previews',
  async (replyPreviewStyle) => {
    setPreference('replyPreviewStyle', replyPreviewStyle);
    render(TimelineItemHarness, {
      props: {
        core,
        item: {
          item: replyItem(undefined, 'none', true),
          collapsed: false,
          currentUserId: '@alice:example.org',
        },
      },
    });
    await tick();

    expect(document.querySelector('.reply-preview .reply-name')?.textContent).toBe('@Bob');
  }
);

test('leaves an unpinged reply target without an at sign', async () => {
  setPreference('replyPreviewStyle', 'connected');
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: replyItem(undefined, 'silent', false),
        collapsed: false,
        currentUserId: '@alice:example.org',
      },
    },
  });
  await tick();

  expect(document.querySelector('.reply-preview .reply-name')?.textContent).toBe('Bob');
});

test('switches between compact and expanded reply cards', async () => {
  setPreference('replyPreviewStyle', 'compact');
  render(TimelineItemHarness, {
    props: { core, item: { item: replyItem(), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('.message-main > .reply-compact .reply-icon')).not.toBeNull();

  setPreference('replyPreviewStyle', 'expanded');
  await tick();
  const expanded = document.querySelector('.message-main > .reply-expanded');
  expect(expanded?.textContent).toContain('Bob');
  expect(expanded?.textContent).toContain('A reply with enough text');
});

test('renders placeholders through the standard message layout', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
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
});

test("shows the sender's role icon after their name", async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false },
      roles: { '@alice:example.org': { icon: '🛡️', color: null } },
    },
  });
  await tick();

  const icon = document.querySelector('header .role-tag-icon');
  expect(icon?.textContent).toBe('🛡️');
  expect(icon?.previousElementSibling?.classList.contains('sender-identity')).toBe(true);
});

test('reads an emote as one sentence, with the name only in the action', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(true), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('.emote')?.textContent.trim()).toBe('* Alice waves');
  expect(document.querySelector('header .sender')).toBeNull();
  expect(document.querySelector('header time')).not.toBeNull();
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
      service: false,
    },
  ];
  render(TimelineItemHarness, {
    props: {
      core,
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
});

test('a deleted message keeps its receipts on the tombstone line', async () => {
  const deleted = {
    ...item(false),
    content: { kind: 'redacted', reason: null } as const,
    read_by: ['@bob:example.org'],
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: deleted, collapsed: true, currentUserId: '@alice:example.org' } },
  });
  await tick();

  expect(document.querySelector('.has-receipts .redacted')).not.toBeNull();
  expect(document.querySelector('.has-receipts .read-receipt-stack')).not.toBeNull();
});

test('the receipt dialog lists readers of later messages, not only the badge', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const members = [
    {
      user_id: '@bob:example.org',
      display_name: 'Bob',
      avatar_url: null,
      power_level: 0,
      membership: 'join' as const,
      member_ts: null,
      kicked: false,
      service: false,
    },
    {
      user_id: '@carol:example.org',
      display_name: 'Carol',
      avatar_url: null,
      power_level: 0,
      membership: 'join' as const,
      member_ts: null,
      kicked: false,
      service: false,
    },
  ];
  const read = { ...item(false), read_by: [] };
  const instance = render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: read,
        collapsed: false,
        members,
        currentUserId: '@alice:example.org',
      },
      readers: ['@bob:example.org', '@carol:example.org'],
    },
  });
  await tick();

  expect(document.querySelector('.read-receipt-stack')).toBeNull();

  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');
  await openMenu(message);
  await tick();

  await user.click(menuItem('Read receipts'));
  await tick();

  const dialog = within(await screen.findByRole('dialog'));
  const listed = dialog.getAllByRole('listitem').map((row) => row.textContent);
  expect(listed.some((row) => row.includes('Bob'))).toBe(true);
  expect(listed.some((row) => row.includes('Carol'))).toBe(true);

  instance.unmount();
  vi.unstubAllGlobals();
});

test('an open message dialog outlives its row leaving the window', async () => {
  const props = $state({
    core,
    item: { item: item(false), collapsed: false },
    readers: ['@bob:example.org'],
    showItem: true,
  });
  render(TimelineItemHarness, { props });
  await tick();

  await openMenu(document.querySelector('.message'));
  await tick();
  await user.click(menuItem('Read receipts'));
  const dialog = await screen.findByRole('dialog');

  props.showItem = false;
  await tick();

  expect(document.querySelector('.message')).not.toBeInTheDocument();
  expect(dialog).toBeInTheDocument();
});

test.each([
  [true, true],
  [false, false],
])('offers pinning when canPin is %s', async (canPin, offered) => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, roomId: '!room:example.org', canPin },
    },
  });
  await tick();

  await openMenu(document.querySelector('.message'));
  await tick();

  const labels = menuLabels();
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.some((label) => label.includes('Pin message'))).toBe(offered);
});

test('keeps the sender header for an ordinary message', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('header .sender')?.textContent).toBe('Alice');
  expect(document.querySelector('.emote')).toBeNull();
});

test('strips a per-message-profile fallback from a thread summary', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: {
          ...item(false),
          thread_root: '$root',
          thread_summary: {
            num_replies: 2,
            latest_event_id: '$reply',
            latest_body: 'Josie: the latest reply',
          },
        },
        collapsed: false,
        onOpenThread: vi.fn(),
        threadPersona: {
          id: 'josie',
          display_name: 'Josie',
          avatar_url: null,
          pronouns: [],
          color_on_light: null,
          color_on_dark: null,
          has_fallback: true,
        },
      },
    },
  });
  await tick();

  expect(document.querySelector('.thread-latest')?.textContent).toBe('the latest reply');
});

test('keeps a thread summary body without a fallback', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: {
          ...item(false),
          thread_root: '$root',
          thread_summary: {
            num_replies: 2,
            latest_event_id: null,
            latest_body: 'we shipped it: finally',
          },
        },
        collapsed: false,
        onOpenThread: vi.fn(),
      },
    },
  });
  await tick();

  expect(document.querySelector('.thread-latest')?.textContent).toBe('we shipped it: finally');
});

test('clicking the sender name mentions the account behind it', async () => {
  const onMentionUser = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
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

  await press(document.querySelector<HTMLButtonElement>('header button.sender'));

  expect(onMentionUser).toHaveBeenCalledWith('@alice:example.org', 'Alice');
});

test('with profile on name click, the sender name opens the profile instead', async () => {
  preferences.usernameClick = 'profile';
  const onMentionUser = vi.fn();
  const onSenderProfile = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, onMentionUser, onSenderProfile },
    },
  });
  await tick();

  await press(document.querySelector<HTMLButtonElement>('header button.sender'));

  expect(onSenderProfile).toHaveBeenCalledWith('@alice:example.org', expect.any(HTMLElement));
  expect(onMentionUser).not.toHaveBeenCalled();
  preferences.usernameClick = 'mention';
});

test('edits an own image caption without dropping its media details', async () => {
  const onEdit = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array());
  const image = {
    ...imageItem(),
    is_own: true,
    content: { ...imageItem().content, caption: 'caption' },
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: image, collapsed: false, onEdit } },
  });
  await tick();

  await hover(document.querySelector('.message'));
  await tick();
  await press(document.querySelector<HTMLButtonElement>('.message-actions button'));

  expect(onEdit).toHaveBeenCalledWith('$item', 'caption', null, true);
});

test('drops the right-hand side of a bubble when own alignment is off', async () => {
  const own = { ...item(false), is_own: true };
  for (const [alignOwn, expected] of [
    [true, true],
    [false, false],
  ] as const) {
    const instance = render(TimelineItemHarness, {
      props: {
        core,
        item: { item: own, collapsed: false, layout: 'bubble', alignOwn },
      },
    });
    await tick();

    expect(document.querySelector('.message.own')?.classList.contains('align-own')).toBe(expected);

    instance.unmount();
  }
});

test('wraps non-text messages in a bubble in bubble layout', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
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
});

test('uses the sender profile name color in every message layout', async () => {
  core.userProfile.mockResolvedValue({
    name_color_light: '#2f5a1f',
    name_color_dark: '#9fd07c',
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await tick();

  const name = document.querySelector<HTMLElement>('.sender');
  expect(name?.classList.contains('tinted')).toBe(true);
  expect(
    document.querySelector<HTMLElement>('.message')?.style.getPropertyValue('--name-color-on-light')
  ).toBe('#2f5a1f');
  expect(
    document.querySelector<HTMLElement>('.message')?.style.getPropertyValue('--name-color-on-dark')
  ).toBe('#9fd07c');
});

test('exposes the default sender colour on the whole message for themes', async () => {
  core.userProfile.mockResolvedValue({ name_color_light: null, name_color_dark: null });
  render(TimelineItemHarness, { props: { core, item: { item: item(false), collapsed: false } } });
  await tick();

  const message = document.querySelector<HTMLElement>('.message');
  expect(message?.style.getPropertyValue('--sender-name-color')).not.toBe('');
});

test('falls back to the role colour when the sender profile has none', async () => {
  core.userProfile.mockResolvedValue({ name_color_light: null, name_color_dark: null });
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false },
      roles: { '@alice:example.org': { icon: null, color: '#c04040' } },
    },
  });
  await tick();

  const message = document.querySelector<HTMLElement>('.message');
  expect(document.querySelector('.sender')?.classList.contains('tinted')).toBe(true);
  expect(message?.style.getPropertyValue('--name-color-on-light')).toBe('#b8383a');
  expect(message?.style.getPropertyValue('--name-color-on-dark')).toBe('#ee6a65');
});

test.each(['connected', 'compact', 'expanded'] as const)(
  'colours a %s reply name from the replied-to sender profile',
  async (replyPreviewStyle) => {
    setPreference('replyPreviewStyle', replyPreviewStyle);
    core.userProfile.mockImplementation((userId: string) =>
      Promise.resolve(
        userId === '@bob:example.org'
          ? { name_color_light: '#2244aa', name_color_dark: '#88aaff' }
          : { name_color_light: null, name_color_dark: null }
      )
    );
    render(TimelineItemHarness, {
      props: { core, item: { item: replyItem(), collapsed: false } },
    });
    await tick();

    const name = document.querySelector<HTMLElement>('.reply-preview .reply-name');
    expect(name?.classList.contains('tinted')).toBe(true);
    expect(name?.style.getPropertyValue('--name-color-on-light')).toBe('#2244aa');
    expect(name?.style.getPropertyValue('--name-color-on-dark')).toBe('#88aaff');
    expect(core.userProfile).toHaveBeenCalledWith('@bob:example.org');
  }
);

test('does not mount hidden message dialogs', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('.sheet-list')).toBeNull();
  expect(document.querySelector('.delete')).toBeNull();
  expect(document.querySelector('.member-list-dialog')).toBeNull();
  expect(document.querySelector('.receipts-dialog')).toBeNull();
});

test('opens an image from a mobile pointer interaction', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const onOpenMedia = vi.fn();
  render(TimelineItemHarness, {
    props: { core, item: { item: imageItem(), collapsed: false, onOpenMedia } },
  });
  await tick();
  const image = document.querySelector<HTMLButtonElement>('.media-image');
  if (!image) throw new Error('media trigger was not rendered');

  image.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
  image.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
  await press(image);

  expect(onOpenMedia).toHaveBeenCalledWith('$item');
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
  render(TimelineItemHarness, {
    props: {
      core,
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
  await press(viaButton);
  expect(onSenderProfile).toHaveBeenCalledWith('@alice:example.org', viaButton);
});

test('without a persona the hover-only via keeps the account MXID', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await tick();

  const via = document.querySelector('header .via');
  expect(via?.className).toContain('via-hidden');
  expect(via?.textContent).toContain('@alice:example.org');
});

test('provides a formatted reaction attribution tooltip', async () => {
  const reacted = {
    ...item(false),
    reactions: [{ key: '👍', senders: ['@alice:example.org'] }],
  };
  render(TimelineItemHarness, {
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
            service: false,
          },
        ],
      },
    },
  });
  await tick();

  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  if (!reaction) throw new Error('reaction was not rendered');
  vi.useFakeTimers();
  await hover(reaction);
  await vi.advanceTimersByTimeAsync(400);
  await tick();

  expect(document.querySelector('.tooltip')?.textContent).toBe('Alice reacted with 👍');
  vi.useRealTimers();
});

test('keeps a long text reaction separate from its count', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: {
          ...item(false),
          reactions: [
            {
              key: 'this is an absurdly long reaction to test the reaction layout',
              senders: ['@alice:example.org'],
            },
          ],
        },
        collapsed: false,
      },
    },
  });
  await tick();

  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  expect(reaction?.querySelector('.reaction-key')?.textContent).toBe(
    'this is an absurdly long reaction to test the reaction layout'
  );
  expect(reaction?.querySelector('.reaction-count')?.textContent).toBe('1');
});

test('mounts the action bar on hover and keeps it while its menu is open', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, onReply: vi.fn(), onCopyLink: vi.fn() },
    },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');
  expect(document.querySelector('.message-actions')).toBeNull();

  await hover(message);
  await tick();
  expect(document.querySelector('.message-actions')).not.toBeNull();

  await press(document.querySelector('.message-actions [data-dropdown-menu-trigger]'));
  await fireEvent.pointerLeave(message, { pointerType: 'mouse' });
  await tick();
  expect(document.querySelector('.message-actions')).not.toBeNull();
});

test('opens message actions on right click', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, onReply: vi.fn(), onCopyLink: vi.fn() },
    },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await openMenu(message);
  await tick();

  expect(menuLabels()).toContain('Reply');
  expect(menuLabels()).toContain('Copy link to message');
});

test('copies a message link when it is right-clicked', async () => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const linked = item(false);
  if (linked.content.kind !== 'message') throw new Error('expected a message');
  linked.content.html = '<a href="https://example.org">Link</a>';
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: linked,
        collapsed: false,
        onReply: vi.fn(),
      },
    },
  });
  await tick();

  await openMenu(screen.getByRole('link', { name: 'Link' }));
  await press(menuItem('Copy link'));

  expect(writeText).toHaveBeenCalledWith('https://example.org/');
});

test('downloads an image from its message menu, with progress on the message', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const listeners: ((event: CoreEvent) => void)[] = [];
  const subscribe = vi.mocked(
    core.subscribeEvents as unknown as (onEvent: (event: CoreEvent) => void) => () => void
  );
  subscribe.mockImplementation((onEvent) => {
    listeners.push(onEvent);
    return () => {};
  });
  let finish: (value: Uint8Array<ArrayBuffer>) => void = () => {};
  const original = new Promise<Uint8Array<ArrayBuffer>>((resolve) => {
    finish = resolve;
  });
  const fetchMedia = vi.mocked(
    core.fetchMedia as unknown as (
      source: string,
      width: number,
      height: number
    ) => Promise<Uint8Array<ArrayBuffer>>
  );
  fetchMedia.mockImplementation((_source, width) =>
    width === 0 ? original : new Promise(() => {})
  );
  const instance = render(TimelineItemHarness, {
    props: { core, item: { item: imageItem(), collapsed: false, onReply: vi.fn() } },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await openMenu(message);
  await tick();
  await user.click(screen.getByRole('menuitem', { name: 'Download' }));
  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/photo', 0, 0);
  });
  await tick();

  for (const listener of listeners) {
    listener({ type: 'media_progress', source: 'mxc://example.org/photo', current: 3, total: 4 });
  }
  await tick();
  expect(document.querySelector<HTMLProgressElement>('progress.upload')?.value).toBe(75);

  finish(bytes);
  await vi.waitFor(() => {
    expect(saveBytes).toHaveBeenCalledWith(bytes, 'photo.png', 'image/png');
  });
  expect(document.querySelector('progress.upload')).toBeNull();
  instance.unmount();
  subscribe.mockImplementation(() => () => {});
  fetchMedia.mockImplementation(() => new Promise(() => {}));
});

test('offers no download for a text message', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false, onReply: vi.fn() } },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await openMenu(message);
  await tick();

  expect(menuLabels()).toContain('Reply');
  expect(menuLabels()).not.toContain('Download');
});

test('long pressing a reaction opens its people list without toggling it', async () => {
  vi.useFakeTimers();
  const onToggleReaction = vi.fn();
  render(TimelineItemHarness, {
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
            service: false,
          },
        ],
      },
    },
  });
  await tick();
  const reaction = document.querySelector<HTMLButtonElement>('.reaction');
  if (!reaction) throw new Error('reaction was not rendered');

  await fireEvent.pointerDown(reaction, { pointerType: 'touch' });
  await vi.advanceTimersByTimeAsync(LONG_PRESS_MS);
  await tick();
  await fireEvent.click(reaction);

  expect(await screen.findByRole('dialog')).toHaveTextContent('Alice');
  expect(document.querySelector('.sheet-list')).toBeNull();
  expect(onToggleReaction).not.toHaveBeenCalled();
  vi.useRealTimers();
});

test('renders a redacted row and a worded state change without throwing', async () => {
  for (const content of [
    { kind: 'redacted', reason: null } as const,
    {
      kind: 'state_event',
      event_type: 'm.room.topic',
      state_key: '',
      content: null,
      prev_content: null,
      change: { kind: 'room_topic', topic: 'what we do' },
    } as const,
    {
      kind: 'state_event',
      event_type: 'm.room.power_levels',
      state_key: '',
      content: { users: {} },
      prev_content: null,
      change: null,
    } as const,
  ]) {
    const target = document.createElement('div');
    document.body.append(target);
    const component = render(TimelineItemHarness, {
      target,
      props: { core, item: { item: { ...item(false), content }, collapsed: false } },
    });
    await tick();

    expect(target.textContent.trim(), `${content.kind} rendered empty`).not.toBe('');
    component.unmount();
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
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(2);
  });
});

test('lifts trailing pronouns out of the display name into a pill', async () => {
  core.userProfile.mockResolvedValue({ pronouns: [] });
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: { ...item(false), sender_name: 'sugary (she/it)' }, collapsed: false },
    },
  });
  await vi.waitFor(() => {
    const name = document.querySelector('header .sender-identity-name');
    expect(name?.textContent).toBe('sugary');
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toBe('she/it');
  });
});

test('adds the display name pronouns after the structured sets', async () => {
  core.userProfile.mockResolvedValue({
    pronouns: [{ summary: 'they/them', language: null }],
  });
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: { ...item(false), sender_name: 'sugary (she/it)' }, collapsed: false },
    },
  });
  await vi.waitFor(() => {
    const name = document.querySelector('header .sender-identity-name');
    expect(name?.textContent).toBe('sugary');
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect([...pills].map((pill) => pill.textContent)).toEqual(['they/them', 'she/it']);
  });
});

test('keeps the display name suffix when pronoun pills are hidden', async () => {
  setPreference('showPronouns', false);
  core.userProfile.mockResolvedValue({ pronouns: [] });
  const instance = render(TimelineItemHarness, {
    props: {
      core,
      item: { item: { ...item(false), sender_name: 'sugary (she/it)' }, collapsed: false },
    },
  });
  await tick();
  expect(document.querySelector('header .sender-identity-name')?.textContent).toBe(
    'sugary (she/it)'
  );
  expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(0);
  instance.unmount();
  setPreference('showPronouns', true);
});

test('shows only the sets tagged with the reader language', async () => {
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: 'en' },
      { summary: 'elle', language: 'fr' },
    ],
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toBe('she/her');
  });
});

test('shows every set once the language filter is switched off', async () => {
  setPreference('filterPronounsByLanguage', false);
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: 'en' },
      { summary: 'elle', language: 'fr' },
    ],
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(2);
  });
  setPreference('filterPronounsByLanguage', true);
  await vi.waitFor(() => {
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(1);
  });
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
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect(pills).toHaveLength(4);
    expect(pills[3].textContent).toBe('+1');
    expect(pills[3].getAttribute('title')).toBe('it/its (en)');
  });
});

test('a touch long press opens the sheet without also opening the context menu', async () => {
  vi.useFakeTimers();
  const instance = render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false, onReply: vi.fn() } },
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

  instance.unmount();
  vi.useRealTimers();
});

test('a touch context menu the row never saw pressed opens the sheet', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  const native = new PointerEvent('contextmenu', {
    pointerType: 'touch',
    bubbles: true,
    cancelable: true,
  });
  document.querySelector('article.message')?.dispatchEvent(native);
  await tick();

  expect(native.defaultPrevented).toBe(true);
  expect(document.querySelectorAll('[data-context-menu-content]')).toHaveLength(0);
  expect(document.querySelector('[data-dialog-content]')).not.toBeNull();
});

test('a deleted message keeps its sender, its time and its menu', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: { ...item(false), content: { kind: 'redacted', reason: null } },
        collapsed: false,
        roomId: '!room:example.org',
        onReply: () => undefined,
      },
    },
  });
  await tick();

  const message = document.querySelector('article.message');
  if (!message) throw new Error('the tombstone was not rendered as a message row');
  expect(document.querySelector('header .sender')?.textContent).toContain('Alice');
  expect(document.querySelector('.redacted')?.textContent.trim()).toBe('Message deleted');

  await hover(message);
  await tick();
  expect(document.querySelector('.message-actions')).not.toBeNull();
});

test('offers to add a message inline emote to your own pack', async () => {
  // The SDK sanitises `data-mx-emoticon` away before the core sees the message.
  const html =
    '<img src="mxc://sable.moe/As8m" alt=":neocat_amogus:" title=":neocat_amogus:" height="32"> ';
  const emoteItem = {
    ...item(false),
    content: {
      kind: 'message' as const,
      body: ':neocat_amogus:',
      html,
      emote: false,
      notice: false,
      edited: false,
    },
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: emoteItem, collapsed: false, onReply: vi.fn() } },
  });
  await tick();
  const message = document.querySelector('.message');
  if (!message) throw new Error('message was not rendered');

  await openMenu(message);
  await tick();

  expect(menuLabels()).toContain('Add emote to my pack');
});

test('a message of only inline emotes reads at jumbo size', async () => {
  const html = '<img alt="rotate" height="32" src="mxc://example.org/rotate" title="rotate"> ';
  const emoteItem = {
    ...item(false),
    content: {
      kind: 'message' as const,
      body: ':rotate:',
      html,
      emote: false,
      notice: false,
      edited: false,
    },
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: emoteItem, collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  expect(document.querySelector('.jumbo-1')).not.toBeNull();
});

test('a membership row keeps its notice look and still carries the action layer', async () => {
  const joined: TimelineItemView = {
    ...item(false),
    content: {
      kind: 'membership',
      user_id: '@alice:example.org',
      change: 'joined',
      display_name: 'Alice',
      reason: null,
    },
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: joined, collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  const row = document.querySelector('article.event-row');
  if (!row) throw new Error('the membership event was not wrapped in an actionable row');
  expect(row.querySelector('.state')).not.toBeNull();
  expect(row.querySelector('header .sender')).toBeNull();

  await hover(row);
  await tick();
  expect(document.querySelector('.message-actions')).not.toBeNull();
});

test('a date divider stays a plain annotation with nothing to act on', async () => {
  const divider: TimelineItemView = {
    ...item(false),
    event_id: null,
    content: { kind: 'date_divider', timestamp: 0 },
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: divider, collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  expect(document.querySelector('article')).toBeNull();
  expect(document.querySelector('.date-divider')).not.toBeNull();
});

test('shows an indeterminate upload bar until the core reports progress', async () => {
  const upload: TimelineItemView = {
    ...imageItem(),
    event_id: null,
    is_own: true,
    send_state: { status: 'sending', progress: null },
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: upload, collapsed: false } },
  });
  await tick();

  const bar = document.querySelector<HTMLProgressElement>('progress.upload');
  expect(bar).not.toBeNull();
  expect(bar?.hasAttribute('value')).toBe(false);
});

test('fills one bar across a gallery and names the item uploading', async () => {
  const gallery: TimelineItemView = {
    ...item(false),
    event_id: null,
    is_own: true,
    send_state: { status: 'sending', progress: { index: 1, current: 50, total: 100 } },
    content: {
      kind: 'gallery',
      body: '',
      html: '',
      items: ['a', 'b', 'c', 'd'].map((name) => ({
        kind: 'file' as const,
        filename: `${name}.zip`,
        caption: null,
        source: `mxc://example.org/${name}`,
        mime: null,
        size: null,
      })),
    },
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: gallery, collapsed: false } },
  });
  await tick();

  expect(document.querySelector<HTMLProgressElement>('progress.upload')?.value).toBeCloseTo(0.375);
  expect(document.querySelector('.transfer-count')?.textContent.trim()).toBe('2 of 4');
});

test('renders a link preview for every link in a message', async () => {
  setPreference('urlPreviews', true);
  const message: TimelineItemView = {
    ...item(false),
    content: {
      kind: 'message',
      body: 'https://example.org/one https://example.org/two',
      html: '<a href="https://example.org/one">one</a> <a href="https://example.org/two">two</a>',
      emote: false,
      notice: false,
      edited: false,
    },
  };
  const instance = render(TimelineItemHarness, {
    props: { core, item: { item: message, collapsed: false, encrypted: false } },
  });
  await vi.waitFor(() => {
    expect(
      [...document.querySelectorAll<HTMLAnchorElement>('a.link-preview')].map((link) => link.href)
    ).toEqual(['https://example.org/one', 'https://example.org/two']);
  });
  instance.unmount();
  setPreference('urlPreviews', false);
});

test('a message whose embeds were removed renders none, bundled or found', async () => {
  setPreference('urlPreviews', true);
  const message: TimelineItemView = {
    ...item(false),
    content: {
      kind: 'message',
      body: 'https://example.org/one',
      html: '<a href="https://example.org/one">one</a>',
      emote: false,
      notice: false,
      edited: true,
    },
    bundled_link_previews: [
      {
        url: 'https://example.org/one',
        title: 'One',
        description: null,
        site_name: null,
        image: null,
        image_mime: null,
        image_width: null,
        image_height: null,
      },
    ],
    link_previews_removed: true,
  };
  const instance = render(TimelineItemHarness, {
    props: { core, item: { item: message, collapsed: false, encrypted: false } },
  });
  await tick();

  expect(document.querySelector('a.link-preview')).toBeNull();
  instance.unmount();
  setPreference('urlPreviews', false);
});

test('compact layout shows the time alone and keeps the full date in the title (#514)', async () => {
  const lastWeek = { ...item(false), timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000 };
  render(TimelineItemHarness, {
    props: { core, item: { item: lastWeek, collapsed: false, layout: 'compact' } },
  });
  await tick();

  const time = document.querySelector('.compact-gutter time');
  expect(time).toHaveTextContent(/^\d{1,2}:\d{2}/);
  expect(time?.getAttribute('title')).toContain(String(new Date(lastWeek.timestamp).getFullYear()));
});
