// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  userProfile: vi.fn().mockRejectedValue(new Error('profile unavailable')),
}));

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

import type { TimelineItemView } from '#src/generated/TimelineItemView';

import StateEventText from './StateEventText.svelte';

afterEach(() => {
  document.body.replaceChildren();
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
    timestamp: 0,
    is_own: false,
    mention: 'none',
    read_by: [],
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
  const onSenderProfile = vi.fn();
  const instance = mount(StateEventText, {
    target: document.body,
    props: {
      item: membership('left', '@bob:example.org', 'Bob'),
      onSenderProfile,
    },
  });
  await tick();
  await tick();

  const name = document.querySelector<HTMLButtonElement>('.state-subject');
  expect(name?.classList.contains('tinted')).toBe(true);
  expect(document.body.textContent).toContain('Bob left');
  name?.click();
  expect(onSenderProfile).toHaveBeenCalledWith('@bob:example.org', name);
  await unmount(instance);
});
