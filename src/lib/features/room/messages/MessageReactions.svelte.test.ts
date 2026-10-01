// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ImagePackView, MemberView, TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';
import { LONG_PRESS_MS } from '#lib/ui/long-press.svelte.js';
import { guardTouchClicks } from '#lib/ui/trailing-click.js';

import MessageReactionsHarness from './MessageReactionsHarness.test.svelte';

const packs = [
  {
    id: 'cats',
    origin: 'account',
    room_id: null,
    name: 'Cats',
    avatar_url: null,
    attribution: null,
    usage: ['emoticon'],
    images: [
      {
        shortcode: 'neocat',
        url: 'mxc://example.org/neocat',
        body: null,
        usage: ['emoticon'],
        info: null,
        source_pack: null,
      },
    ],
  },
] satisfies ImagePackView[];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test.each(['touch', 'pen', ''])(
  'reaction long-press does not open the message menu (%s)',
  async (pointerType) => {
    vi.useFakeTimers();
    const stopGuard = guardTouchClicks();
    const onViewReactions = vi.fn();
    const onMessageMenu = vi.fn();
    const onToggleReaction = vi.fn();
    render(MessageReactionsHarness, {
      reactions: [{ key: '👍', senders: ['@alice:example.org'] }],
      eventId: '$event',
      currentUserId: null,
      members: [],
      roomId: '!room:example.org',
      actionable: false,
      onViewReactions,
      onToggleReaction,
      onMessageContextMenu: onMessageMenu,
    });
    const reaction = screen.getByRole('button', { name: /👍/ });
    try {
      await fireEvent.pointerDown(reaction, { pointerType: 'touch', isPrimary: true });
      vi.advanceTimersByTime(LONG_PRESS_MS);
      const menu = new PointerEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        pointerType,
      });
      await fireEvent(reaction, menu);
      await fireEvent.pointerUp(reaction, { pointerType: 'touch', isPrimary: true });
      await fireEvent.click(reaction);

      expect(onViewReactions).toHaveBeenCalledExactlyOnceWith(0);
      expect(menu.defaultPrevented).toBe(true);
      expect(onMessageMenu).not.toHaveBeenCalled();
      expect(onToggleReaction).not.toHaveBeenCalled();
    } finally {
      stopGuard();
    }
  }
);

test.each(['mouse', 'keyboard'])('reaction contextmenu opens only details (%s)', async (input) => {
  const onViewReactions = vi.fn();
  const onMessageMenu = vi.fn();
  render(MessageReactionsHarness, {
    reactions: [{ key: '👍', senders: ['@alice:example.org'] }],
    eventId: '$event',
    currentUserId: null,
    members: [],
    roomId: '!room:example.org',
    actionable: false,
    onViewReactions,
    onMessageContextMenu: onMessageMenu,
  });
  const menu =
    input === 'mouse'
      ? new PointerEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          pointerType: 'mouse',
        })
      : new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

  await fireEvent(screen.getByRole('button', { name: /👍/ }), menu);

  expect(onViewReactions).toHaveBeenCalledExactlyOnceWith(0);
  expect(menu.defaultPrevented).toBe(true);
  expect(onMessageMenu).not.toHaveBeenCalled();
});

test('uses a custom emote shortcode rather than its Matrix media URI', async () => {
  Object.assign(core.commands, { imagePacks: vi.fn(() => Promise.resolve(packs)) });

  render(MessageReactionsHarness, {
    reactions: [
      {
        key: 'mxc://example.org/neocat',
        senders: ['@alice:example.org'],
      },
    ] satisfies TimelineItemView['reactions'],
    eventId: '$event',
    currentUserId: null,
    members: [] as MemberView[],
    roomId: '!room:example.org',
    actionable: false,
  });

  expect(await screen.findByLabelText(/:neocat:/)).toHaveClass('reaction');
  expect(document.body).not.toHaveTextContent('mxc://example.org/neocat');
});

test('names an image from a pack we cannot see by the shortcode it was sent with', async () => {
  Object.assign(core.commands, {
    imagePacks: vi.fn(() => Promise.resolve([])),
    reactionShortcodes: vi.fn(() =>
      Promise.resolve([{ key: 'mxc://remote.example/parrot', shortcode: 'partyparrot' }])
    ),
  });

  render(MessageReactionsHarness, {
    reactions: [
      { key: 'mxc://remote.example/parrot', senders: ['@alice:example.org'] },
    ] satisfies TimelineItemView['reactions'],
    eventId: '$named',
    currentUserId: null,
    members: [] as MemberView[],
    roomId: '!room:example.org',
    actionable: false,
  });

  expect(await screen.findByLabelText(/:partyparrot:/)).toHaveClass('reaction');
});

test('shows the shortcode in place of an image that cannot load', async () => {
  Object.assign(core.commands, {
    imagePacks: vi.fn(() => Promise.resolve([])),
    reactionShortcodes: vi.fn(() =>
      Promise.resolve([{ key: 'mxc://dead.example/parrot', shortcode: 'partyparrot' }])
    ),
  });
  core.fetchMedia.mockRejectedValueOnce(new Error('unavailable'));

  render(MessageReactionsHarness, {
    reactions: [
      { key: 'mxc://dead.example/parrot', senders: ['@alice:example.org'] },
    ] satisfies TimelineItemView['reactions'],
    eventId: '$fallback',
    currentUserId: null,
    members: [] as MemberView[],
    roomId: '!room:example.org',
    actionable: false,
  });

  expect(await screen.findByText(':partyparrot:')).toHaveClass('reaction-shortcode');
});

test('a custom emote reaction shows its shortcode where media previews are off (MSC4278)', async () => {
  Object.assign(core.commands, { imagePacks: vi.fn(() => Promise.resolve(packs)) });
  mediaPreviewSettings.global = { media_previews: 'off' };

  render(MessageReactionsHarness, {
    reactions: [{ key: 'mxc://example.org/neocat', senders: ['@alice:example.org'] }],
    eventId: '$event',
    currentUserId: null,
    members: [],
    roomId: '!room:example.org',
    actionable: false,
    joinRule: 'invite',
  });

  expect(await screen.findByText(':neocat:')).toHaveClass('reaction-shortcode');
  expect(document.querySelector('.reaction-image')).toBeNull();
  mediaPreviewSettings.global = {};
});
