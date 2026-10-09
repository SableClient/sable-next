// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));

import { core } from '#lib/core/__mocks__/context.js';
import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
import type { IncomingCall } from './incoming-calls.svelte.js';
import IncomingCallDialog from './IncomingCallDialog.svelte';

const call: IncomingCall = {
  roomId: '!room:example.org',
  notificationEventId: '$call',
  sender: '@alice:example.org',
  senderName: 'Room Alice',
  roomName: 'Room',
  ring: true,
  hasVideo: false,
  expiresAtMs: Date.now() + 60_000,
};

beforeEach(() => {
  core.roomStateEvent.mockReset();
  core.userProfile.mockReset();
  core.fetchMedia.mockClear();
  core.userProfile.mockResolvedValue({
    display_name: 'Global Alice',
    avatar_url: 'mxc://example.org/global-call-avatar',
  });
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => {
    const media = matchMedia(query);
    if (query === BREAKPOINTS.appLayout) Object.defineProperty(media, 'matches', { value: false });
    return media;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function showCall() {
  return render(IncomingCallDialog, {
    call,
    roomName: 'Room',
    onAccept: vi.fn(),
    onDecline: vi.fn(),
  });
}

test('incoming calls show the room profile instead of the global profile', async () => {
  const request = Promise.withResolvers<unknown>();
  core.roomStateEvent.mockReturnValue(request.promise);
  showCall();
  await tick();
  expect(screen.getByText('Room Alice is calling')).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toHaveClass('dialog-content-fullscreen');
  expect(core.roomStateEvent).toHaveBeenCalledWith(call.roomId, 'm.room.member', call.sender);
  request.resolve({
    membership: 'join',
    displayname: 'Room Alice',
    avatar_url: 'mxc://example.org/room-call-avatar',
  });

  await vi.waitFor(() => {
    expect(screen.getByText('Room Alice is calling')).toBeInTheDocument();
    expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/room-call-avatar', 96, 96);
  });
  expect(core.userProfile).not.toHaveBeenCalled();
});

test('cleared room identity fields do not fall back to the global profile', async () => {
  core.roomStateEvent.mockResolvedValue({
    membership: 'join',
    displayname: null,
    avatar_url: null,
  });
  showCall();

  expect(await screen.findByText(`${call.sender} is calling`)).toBeInTheDocument();
  expect(document.querySelector('.who .media-image')).toBeNull();
  expect(core.userProfile).not.toHaveBeenCalled();
});

test('retains the call event name when membership cannot be loaded', async () => {
  core.roomStateEvent.mockRejectedValue(new Error('unavailable'));
  showCall();
  await tick();

  expect(screen.getByText('Room Alice is calling')).toBeInTheDocument();
  expect(core.userProfile).not.toHaveBeenCalled();
});

test('a late membership lookup does not replace a newer call from the same sender', async () => {
  const previous = Promise.withResolvers<unknown>();
  core.roomStateEvent.mockReturnValueOnce(previous.promise).mockResolvedValue({
    membership: 'join',
    displayname: 'Other Room Alice',
    avatar_url: 'mxc://example.org/other-room-call-avatar',
  });
  const view = showCall();
  await tick();
  await view.rerender({
    call: {
      ...call,
      roomId: '!other:example.org',
      notificationEventId: '$other-call',
      senderName: 'Other Room Alice',
    },
  });
  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalledWith(
      'mxc://example.org/other-room-call-avatar',
      96,
      96
    );
  });

  previous.resolve({ membership: 'join', displayname: 'Old Room Alice', avatar_url: null });
  await tick();

  expect(screen.getByText('Other Room Alice is calling')).toBeInTheDocument();
  expect(screen.queryByText('Old Room Alice is calling')).not.toBeInTheDocument();
});

test('closing a call ignores its pending membership lookup', async () => {
  const request = Promise.withResolvers<unknown>();
  core.roomStateEvent.mockReturnValue(request.promise);
  const view = showCall();
  await tick();
  await view.rerender({ call: null });

  request.resolve({
    membership: 'join',
    displayname: 'Room Alice',
    avatar_url: 'mxc://example.org/closed-call-avatar',
  });
  await tick();

  expect(screen.queryByText('Room Alice is calling')).not.toBeInTheDocument();
  expect(core.fetchMedia).not.toHaveBeenCalledWith('mxc://example.org/closed-call-avatar', 96, 96);
});
