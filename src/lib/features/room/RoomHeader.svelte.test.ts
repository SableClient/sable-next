// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { expect, test } from 'vitest';

import RoomHeader from './RoomHeader.svelte';

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
  {
    user_id: '@carol:example.org',
    display_name: 'Carol',
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
  },
];

function mountHeader(props: {
  isVoice: boolean;
  callParticipants: readonly string[];
}): ReturnType<typeof mount> {
  return mount(RoomHeader, {
    target: document.body,
    props: {
      roomName: 'General',
      roomAvatar: null,
      members,
      onBack: () => {},
      onMembers: () => {},
      onSearch: () => {},
      ...props,
    },
  });
}

test('a voice room with nobody in it is marked as a voice room', async () => {
  const instance = mountHeader({ isVoice: true, callParticipants: [] });
  await tick();

  const chip = document.querySelector('.voice-chip');
  expect(chip?.getAttribute('role')).toBe('img');
  expect(chip?.getAttribute('aria-label')).toBe('Voice room');
  expect(chip?.classList.contains('live')).toBe(false);
  expect(chip?.querySelector('.voice-count')).toBeNull();

  await unmount(instance);
});

test('participants name themselves in the chip, whatever the room type', async () => {
  const instance = mountHeader({
    isVoice: false,
    callParticipants: ['@bob:example.org', '@carol:example.org'],
  });
  await tick();

  const chip = document.querySelector('.voice-chip');
  expect(chip?.getAttribute('aria-label')).toBe('In voice: Bob, Carol');
  expect(chip?.classList.contains('live')).toBe(true);
  expect(chip?.querySelectorAll('.sable-avatar')).toHaveLength(2);
  expect(chip?.querySelector('.voice-count')?.textContent).toBe('2');

  await unmount(instance);
});

test('a text room with no call shows no chip', async () => {
  const instance = mountHeader({ isVoice: false, callParticipants: [] });
  await tick();

  expect(document.querySelector('.voice-chip')).toBeNull();

  await unmount(instance);
});
