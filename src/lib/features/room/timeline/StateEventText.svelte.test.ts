// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import type { TimelineItemView } from '#src/generated/protocol';

import StateEventText from './StateEventText.svelte';

afterEach(() => {
  core.userProfile.mockReset();
  core.userProfile.mockRejectedValue(new Error('profile unavailable'));
});

function membership(change: 'left' | 'joined', userId: string, name: string): TimelineItemView {
  return {
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
  };
}

test.each([
  [{ kind: 'call_invite' }, 'Alice sent a call invitation'],
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
