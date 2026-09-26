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
