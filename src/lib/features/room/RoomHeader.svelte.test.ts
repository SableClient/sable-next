// @vitest-environment happy-dom

import { screen } from '@testing-library/svelte';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { preferences } from '#lib/settings/preferences.svelte.js';
import RoomHeader from './RoomHeader.svelte';
import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.ts';

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
  encrypted?: boolean | null;
}) {
  return renderWithTooltips(RoomHeader, {
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

test('the hidden events toggle appears only when enabled and flips the preference', async () => {
  const user = userEvent.setup();
  mountHeader({ isVoice: false, callParticipants: [] });
  expect(screen.queryByRole('button', { name: 'Show hidden events' })).not.toBeInTheDocument();

  preferences.developerTools = true;
  preferences.hiddenEventsHeaderToggle = true;
  try {
    const toggle = await screen.findByRole('button', { name: 'Show hidden events' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await user.click(toggle);
    expect(preferences.showHiddenEvents).toBe(true);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  } finally {
    preferences.developerTools = false;
    preferences.hiddenEventsHeaderToggle = false;
    preferences.showHiddenEvents = false;
  }
});

test('opens the room image from the header', async () => {
  const openStandaloneSpy = vi.spyOn(mediaViewerState, 'openStandalone');
  renderWithTooltips(RoomHeader, {
    props: {
      roomId: '!general:example.org',
      roomName: 'General',
      roomAvatar: 'mxc://example.org/room',
      members,
      isVoice: false,
      callParticipants: [],
      onBack: () => {},
      onMembers: () => {},
      onSearch: () => {},
    },
  });
  await userEvent.setup().click(screen.getByRole('button', { name: 'View avatar of General' }));
  expect(openStandaloneSpy).toHaveBeenCalledExactlyOnceWith('mxc://example.org/room', 'General');
});

test('the header shows whether the room is end-to-end encrypted', () => {
  const { unmount } = mountHeader({ isVoice: false, callParticipants: [], encrypted: true });
  expect(
    screen.getByRole('img', { name: 'Messages in this room are end-to-end encrypted.' })
  ).toBeInTheDocument();
  unmount();

  mountHeader({ isVoice: false, callParticipants: [], encrypted: false });
  expect(
    screen.getByRole('img', { name: 'Messages in this room are not end-to-end encrypted.' })
  ).toBeInTheDocument();
});

test('the header claims nothing while encryption is unknown', () => {
  const { container } = mountHeader({ isVoice: false, callParticipants: [], encrypted: null });

  expect(container.querySelector('.encryption-state')).not.toBeInTheDocument();
});
