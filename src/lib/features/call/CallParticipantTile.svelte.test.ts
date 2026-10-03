// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { Room } from 'livekit-client';

import CallParticipantTile from './CallParticipantTile.svelte';

function mountTile() {
  render(CallParticipantTile, {
    participant: { identity: '@bob:example.org:DEVICE', microphone: undefined },
    source: 'camera',
    room: undefined,
    name: 'Bob',
    userId: '@bob:example.org',
    avatar: null,
  });
  return userEvent.setup();
}

async function openFromContextMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('listitem') });
}

const panel = () => screen.queryByRole('slider', { name: 'Volume for Bob' });

test('closes the volume panel on a pointer down outside it', async () => {
  const user = mountTile();
  await openFromContextMenu(user);
  expect(panel()).toBeInTheDocument();

  await user.pointer({ keys: '[MouseLeft]', target: screen.getByText('100%') });
  expect(panel()).toBeInTheDocument();

  await user.pointer({ keys: '[MouseLeft]', target: document.body });
  expect(panel()).not.toBeInTheDocument();
});

test('closes the volume panel on Escape', async () => {
  const user = mountTile();
  await openFromContextMenu(user);

  await user.keyboard('{Escape}');
  expect(panel()).not.toBeInTheDocument();
});

test('our own camera on a native call is a slot for the native view', () => {
  const localVideo = {
    place: vi.fn(() => Promise.resolve()),
    clear: vi.fn(() => Promise.resolve()),
  };
  const { container, unmount } = render(CallParticipantTile, {
    participant: {
      identity: '@erwan:example.org:PHONE',
      local: true,
      camera: { id: 'camera', muted: false, subscribed: true },
    },
    source: 'camera',
    room: undefined,
    localVideo,
    name: 'Erwan',
    userId: '@erwan:example.org',
    avatar: null,
  });

  expect(container.querySelector('video')).not.toBeInTheDocument();
  expect(container.querySelector('div.video')).toBeInTheDocument();
  expect(screen.getByText('Erwan')).toBeInTheDocument();

  unmount();
  expect(localVideo.clear).toHaveBeenCalled();
});

test('the volume button still toggles the panel closed', async () => {
  const user = mountTile();
  await openFromContextMenu(user);

  await user.click(screen.getByRole('button', { name: 'Volume for Bob' }));
  expect(panel()).not.toBeInTheDocument();
});

function mountScreen(screenShareAudio: boolean, onVolumeChange = vi.fn()) {
  render(CallParticipantTile, {
    participant: {
      identity: '@bob:example.org:DEVICE',
      screenShare: { id: 'TR_video', muted: false, subscribed: true },
      screenShareAudio: screenShareAudio
        ? { id: 'TR_audio', muted: false, subscribed: true }
        : undefined,
    },
    source: 'screen',
    watchingScreen: true,
    room: undefined,
    name: 'Bob',
    userId: '@bob:example.org',
    avatar: null,
    onVolumeChange,
  });
  return userEvent.setup();
}

test('a shared screen with sound has its own volume, apart from the voice', async () => {
  const onVolumeChange = vi.fn();
  const user = mountScreen(true, onVolumeChange);

  await user.click(screen.getByRole('button', { name: "Volume of Bob's screen" }));
  const slider = screen.getByRole('slider', { name: "Volume of Bob's screen" });
  slider.focus();
  await user.keyboard('{ArrowLeft}');

  expect(screen.getByText('95%')).toBeInTheDocument();
  expect(onVolumeChange).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('sable-call-volumes') ?? '{}')).toMatchObject({
    'screen:@bob:example.org': 0.95,
  });
});

test('a shared screen without sound offers no volume', () => {
  mountScreen(false);

  expect(screen.queryByRole('button', { name: "Volume of Bob's screen" })).not.toBeInTheDocument();
});

test('attaches screen video only while watching and detaches it when stopped', async () => {
  const track = { attach: vi.fn(), detach: vi.fn() };
  const onWatchScreen = vi.fn();
  const room = {
    remoteParticipants: new Map([['bob', { getTrackPublication: () => ({ track }) }]]),
  } as unknown as Room;
  const { container, rerender } = render(CallParticipantTile, {
    participant: {
      identity: 'bob',
      screenShare: { id: 'video', muted: false, subscribed: true },
      screenShareAudio: { id: 'audio', muted: false, subscribed: true },
    },
    source: 'screen',
    room,
    name: 'Bob',
    userId: '@bob:example.org',
    avatar: null,
    watchingScreen: false,
    onWatchScreen,
  });
  expect(screen.getByText("Bob's screen")).toBeInTheDocument();
  expect(screen.getByRole('button', { name: "Watch Bob's screen" })).toHaveTextContent('Watch');
  expect(track.attach).not.toHaveBeenCalled();
  expect(container.querySelector('video')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: "Volume of Bob's screen" })).not.toBeInTheDocument();

  await rerender({ watchingScreen: true });
  const video = container.querySelector('video');
  expect(track.attach).toHaveBeenCalledWith(video);
  await userEvent.setup().click(screen.getByRole('button', { name: "Stop watching Bob's screen" }));
  expect(onWatchScreen).toHaveBeenCalledOnce();

  await rerender({ watchingScreen: false });
  expect(track.detach).toHaveBeenCalledWith(video);
  expect(container.querySelector('video')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: "Watch Bob's screen" })).toBeInTheDocument();
});

test('a watched screen attaches the track that arrives after a resubscribe', () => {
  const first = { attach: vi.fn(), detach: vi.fn() };
  const second = { attach: vi.fn(), detach: vi.fn() };
  let track: typeof first | undefined = first;
  const room = {
    remoteParticipants: new Map([['bob', { getTrackPublication: () => ({ track }) }]]),
  } as unknown as Room;
  const participant = $state({
    identity: 'bob',
    screenShare: { id: 'video', muted: false, subscribed: true },
  });
  const { container } = render(CallParticipantTile, {
    participant,
    source: 'screen',
    room,
    name: 'Bob',
    userId: '@bob:example.org',
    avatar: null,
    watchingScreen: true,
  });
  const video = container.querySelector('video');
  expect(first.attach).toHaveBeenCalledWith(video);

  track = undefined;
  participant.screenShare.subscribed = false;
  flushSync();
  expect(first.detach).toHaveBeenCalledWith(video);

  track = second;
  participant.screenShare.subscribed = true;
  flushSync();
  expect(second.attach).toHaveBeenCalledWith(video);
});
