// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import { giveNickname } from '#lib/profile/profile-override-fixtures.js';

import type { TimelineItemView } from '#src/generated/protocol';

import StateEventText from './StateEventText.svelte';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

afterEach(() => {
  core.userProfile.mockReset();
  core.userProfile.mockRejectedValue(new Error('profile unavailable'));
});

function membership(change: 'left' | 'joined', userId: string, name: string): TimelineItemView {
  return withRowFields({
    id: 'state',
    event_id: '$state',
    transaction_id: null,
    send_state: null,
    sender: userId,
    sender_name: name,
    sender_avatar: null,
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    timestamp: 0,
    is_own: false,
    mention: 'none',
    forwarded: null,
    forum_title: null,
    shield: null,
    read_by: [],
    read_timestamps: {},
    reactions: [],
    thread_root: null,
    thread_summary: null,
    in_reply_to: null,
    content: {
      kind: 'membership',
      change,
      user_id: userId,
      display_name: name,
      reason: null,
    },
  });
}

test.each([
  [{ kind: 'call_invite' }, 'Alice sent a call invitation'],
  [{ kind: 'verification_request' }, 'Alice requested verification'],
  [{ kind: 'cute', cute_type: 'hug', body: '🤗' }, 'Alice sent a hug 🤗'],
  [{ kind: 'cute', cute_type: 'googly_eyes', body: '👀' }, 'Alice sent googly eyes 👀'],
  [{ kind: 'cute', cute_type: 'unknown', body: '✨' }, 'Alice sent ✨'],
  [{ kind: 'malformed', event_type: 'm.room.message' }, 'Could not read event: m.room.message'],
] satisfies [TimelineItemView['content'], string][])(
  'renders the event notice for %j',
  (content, expected) => {
    const item = { ...membership('joined', '@alice:example.org', 'Alice'), content };
    const { container } = render(StateEventText, { item });
    expect(container).toHaveTextContent(expected);
  }
);

test('tints a clickable state-event name from the sender profile', async () => {
  core.userProfile.mockResolvedValue({
    user_id: '@bob:example.org',
    display_name: 'Bob',
    avatar_url: null,
    bio: null,
    hero_color: null,
    hero_brightness: null,
    banner_url: null,
    status: null,
    pronouns: [],
    timezone: null,
    name_color_light: '#4f7a3a',
    name_color_dark: '#9fd07c',
    animal: null,
    extra: [],
  });
  const user = userEvent.setup();
  const onSenderProfile = vi.fn();
  const { container } = render(StateEventText, {
    item: membership('left', '@bob:example.org', 'Bob'),
    onSenderProfile,
  });

  const name = screen.getByRole('button', { name: /Bob/ });
  await vi.waitFor(() => {
    expect(name).toHaveClass('tinted');
  });
  expect(container).toHaveTextContent('Bob left');
  await user.click(name);
  expect(onSenderProfile).toHaveBeenCalledWith('@bob:example.org', name);
});

test('a state-event name shows the local nickname', async () => {
  await giveNickname('@bob:example.org', 'Bobby');

  const { container } = render(StateEventText, {
    item: membership('left', '@bob:example.org', 'Bob'),
    onSenderProfile: vi.fn(),
  });

  expect(container).toHaveTextContent('Bobby left');
});

test('notice text without a clickable name still uses the nickname', async () => {
  await giveNickname('@bob:example.org', 'Bobby');

  const pinned = {
    ...membership('joined', '@bob:example.org', 'Bob'),
    content: {
      kind: 'state_event',
      event_type: 'm.room.pinned_events',
      state_key: '',
      content: null,
      prev_content: null,
      change: { kind: 'pinned_events', added: ['$x'], removed: [], total: 1 },
    },
  } as TimelineItemView;
  const { container } = render(StateEventText, { item: pinned });

  expect(container).toHaveTextContent('Bobby pinned a message');
});
