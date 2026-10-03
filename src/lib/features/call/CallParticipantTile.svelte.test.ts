// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

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

function mountSharer(onWatchScreen?: () => void) {
  render(CallParticipantTile, {
    participant: {
      identity: '@bob:example.org:DEVICE',
      screenShare: { id: 'TR_video', muted: false, subscribed: true },
    },
    source: 'camera',
    room: undefined,
    name: 'Bob',
    userId: '@bob:example.org',
    avatar: null,
    onWatchScreen,
  });
}

test('a tile whose person is sharing carries a live badge that opens the share', async () => {
  const onWatchScreen = vi.fn();
  mountSharer(onWatchScreen);

  await userEvent.setup().click(screen.getByRole('button', { name: "Watch Bob's screen" }));
  expect(onWatchScreen).toHaveBeenCalledOnce();
});

test('a tile with no share has no live badge', () => {
  mountTile();
  expect(screen.queryByText('Live')).not.toBeInTheDocument();
});
