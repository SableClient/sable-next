// @vitest-environment happy-dom

import { render, screen, type RenderResult } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
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

function mountHeader(props: {
  isVoice: boolean;
  callParticipants: readonly string[];
  onToggleChat?: (() => void) | null;
  chatOpen?: boolean;
  searchOpen?: boolean;
  membersOpen?: boolean;
}): RenderResult<typeof RoomHeader> {
  return render(RoomHeader, {
    props: {
      roomId: '!general:example.org',
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

test('a voice room with nobody in it is marked as a voice room', () => {
  mountHeader({ isVoice: true, callParticipants: [] });

  const chip = screen.getByRole('img', { name: 'Voice room' });
  expect(chip).not.toHaveClass('live');
  expect(chip.querySelector('.voice-count')).not.toBeInTheDocument();
});

test('participants name themselves in the chip, whatever the room type', () => {
  mountHeader({
    isVoice: false,
    callParticipants: ['@bob:example.org', '@carol:example.org'],
  });

  const chip = screen.getByRole('img', { name: 'In voice: Bob, Carol' });
  expect(chip).toHaveClass('live');
  expect(chip.querySelectorAll('.avatar-root')).toHaveLength(2);
  expect(chip).toHaveTextContent('2');
});

test('a text room with no call shows no chip', () => {
  mountHeader({ isVoice: false, callParticipants: [] });

  expect(screen.queryByRole('img', { name: /voice/i })).not.toBeInTheDocument();
});

test('a voice room swaps the timeline in and out from the header', async () => {
  const user = userEvent.setup();
  let toggled = 0;
  mountHeader({
    isVoice: true,
    callParticipants: [],
    onToggleChat: () => {
      toggled += 1;
    },
  });

  await user.click(screen.getByRole('button', { name: 'Show chat' }));
  expect(toggled).toBe(1);
});

test('a text room has no chat toggle', () => {
  mountHeader({ isVoice: false, callParticipants: [] });

  expect(screen.queryByRole('button', { name: /chat$/ })).not.toBeInTheDocument();
});

test('every header toggle exposes its open state for themes', () => {
  mountHeader({ isVoice: false, callParticipants: [], searchOpen: true, membersOpen: false });

  expect(screen.getByRole('button', { name: 'Search messages' })).toHaveAttribute(
    'data-state',
    'open'
  );
  expect(screen.getByRole('button', { name: 'Members' })).toHaveAttribute('data-state', 'closed');
  expect(screen.getByRole('button', { name: 'Back to rooms' })).not.toHaveAttribute('data-state');
});
