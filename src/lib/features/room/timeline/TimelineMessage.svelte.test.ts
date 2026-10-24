// @vitest-environment happy-dom

import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

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
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { setPreference } from '#lib/settings/preferences.svelte.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';
import {
  core,
  user,
  press,
  openMenu,
  hover,
  menuItem,
  resetTimelineItemTest,
  item,
  imageItem,
  replyItem,
} from './timeline-item-fixtures';
import { senderColor } from './timeline-format';
import { withRowFields } from './row-fixtures.js';

afterEach(resetTimelineItemTest);

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

test('reads an emote as one sentence, with the name only in the action', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(true), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('.emote')?.textContent.replace(/\s+/g, ' ').trim()).toBe(
    '* Alice waves'
  );
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
  expect(badge?.querySelector('[aria-label="Bob"]')).not.toBeNull();

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
  const deleted = withRowFields({
    ...item(false),
    content: { kind: 'redacted', reason: null, redacted_by: null } as const,
    read_by: ['@bob:example.org'],
  });
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

test('keeps the sender header for an ordinary message', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await tick();

  expect(document.querySelector('header .sender')?.textContent).toBe('Alice');
  expect(document.querySelector('.emote')).toBeNull();
});

test('an undecryptable message keeps its sender and avatar', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: withRowFields({
          ...item(false),
          content: { kind: 'unable_to_decrypt', reason: 'unknown', session_id: null },
        }),
        collapsed: false,
        roomId: '!room:example.org',
      },
    },
  });
  await tick();

  expect(document.querySelector('header .sender')?.textContent).toBe('Alice');
  expect(document.querySelector('.message-avatar')).toBeInTheDocument();
  expect(document.querySelector('.message-main .undecryptable')).toBeInTheDocument();
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
            latest_fallback: null,
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
            latest_fallback: null,
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

test('names a verification request as the latest thread reply', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: {
          ...item(false),
          thread_root: '$root',
          thread_summary: {
            num_replies: 1,
            latest_event_id: '$reply',
            latest_body: null,
            latest_fallback: { kind: 'verification_request' },
          },
        },
        collapsed: false,
        onOpenThread: vi.fn(),
      },
    },
  });
  await tick();

  expect(document.querySelector('.thread-latest')?.textContent).toBe('Requested verification');
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
  await vi.waitFor(() => {
    expect(document.querySelector('.sender')?.classList.contains('tinted')).toBe(true);
  });
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
      roles: { '@alice:example.org': { icon: null, name: null, color: '#c04040' } },
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
    await vi.waitFor(() => {
      expect(
        document.querySelector('.reply-preview .reply-name')?.classList.contains('tinted')
      ).toBe(true);
    });
    const name = document.querySelector<HTMLElement>('.reply-preview .reply-name');
    expect(name?.style.getPropertyValue('--name-color-on-light')).toBe('#2244aa');
    expect(name?.style.getPropertyValue('--name-color-on-dark')).toBe('#88aaff');
    expect(core.userProfile).toHaveBeenCalledWith(
      '@bob:example.org',
      false,
      expect.any(AbortSignal)
    );
  }
);

test('a deleted message keeps its sender, its time and its menu', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: withRowFields({
          ...item(false),
          content: { kind: 'redacted', reason: null, redacted_by: null },
        }),
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

test('a message the core sized as jumbo reads at that size', async () => {
  const html = '<img alt="rotate" height="32" src="mxc://example.org/rotate" title="rotate"> ';
  const emoteItem = withRowFields({
    ...item(false),
    content: {
      kind: 'message' as const,
      body: ':rotate:',
      html,
      emote: false,
      notice: false,
      edited: false,
      jumbo: 1,
    },
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: emoteItem, collapsed: false, onReply: vi.fn() } },
  });
  await tick();

  expect(document.querySelector('.jumbo-1')).not.toBeNull();
});

test('renders a link preview for every link in a message', async () => {
  setPreference('urlPreviews', true);
  const message: ResolvedItem = withRowFields({
    ...item(false),
    content: {
      kind: 'message',
      body: 'https://example.org/one https://example.org/two',
      html: '<a href="https://example.org/one">one</a> <a href="https://example.org/two">two</a>',
      emote: false,
      notice: false,
      edited: false,
    },
  });
  const instance = render(TimelineItemHarness, {
    props: { core, item: { item: message, collapsed: false, encrypted: false } },
  });
  await vi.waitFor(() => {
    expect(
      [...document.querySelectorAll<HTMLAnchorElement>('.link-preview > a.link-preview-text')].map(
        (link) => link.href
      )
    ).toEqual(['https://example.org/one', 'https://example.org/two']);
  });
  instance.unmount();
  setPreference('urlPreviews', false);
});

test('a message whose embeds were removed renders none, bundled or found', async () => {
  setPreference('urlPreviews', true);
  const message: ResolvedItem = withRowFields({
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
        video: null,
        theme_color: null,
        card: null,
        author_name: null,
      },
    ],
    link_previews_removed: true,
  });
  const instance = render(TimelineItemHarness, {
    props: { core, item: { item: message, collapsed: false, encrypted: false } },
  });
  await tick();

  expect(document.querySelector('a.link-preview')).toBeNull();
  instance.unmount();
  setPreference('urlPreviews', false);
});

test('compact layout shows the time alone and keeps the full date in its tooltip (#514)', async () => {
  const lastWeek = { ...item(false), timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000 };
  render(TimelineItemHarness, {
    props: { core, item: { item: lastWeek, collapsed: false, layout: 'compact' } },
  });
  await tick();

  const time = document.querySelector('.compact-gutter time');
  expect(time?.textContent).toMatch(/^\d{1,2}:\d{2}/);
  if (!time) throw new Error('compact layout has no time');
  await userEvent.hover(time);
  await vi.waitFor(() => {
    expect(document.querySelector('[data-tooltip-content]')).toHaveTextContent(
      String(new Date(lastWeek.timestamp).getFullYear())
    );
  });
});

test('quotes a reply to a membership event as its timeline text', async () => {
  const target: ResolvedItem = withRowFields({
    ...item(false),
    id: 'member',
    event_id: '$original',
    content: {
      kind: 'membership',
      user_id: '@nex:example.org',
      change: 'left',
      display_name: 'nex',
      reason: null,
    },
  });
  const base = replyItem('');
  const reply: ResolvedItem = {
    ...base,
    in_reply_to: base.in_reply_to && { ...base.in_reply_to, body: null },
  };
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: reply, collapsed: false, events: { get: () => target } as never },
    },
  });
  await tick();

  expect(document.querySelector('.reply-body')?.textContent).toBe('nex left the room');
});
