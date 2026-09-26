// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import VoiceLobby from './VoiceLobby.svelte';
import VoiceLobbyHarness from './VoiceLobbyHarness.test.svelte';

test('hides the permission error when a call service is unavailable', () => {
  render(VoiceLobby, {
    props: {
      participants: [],
      members: [],
      media: { microphone: true, camera: false },
      joining: false,
      canJoin: false,
      hasPermission: true,
      onChange: vi.fn(),
      onJoin: vi.fn(),
    },
  });

  expect(screen.queryByText("You don't have permission to join.")).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('shows the permission error when joining is forbidden', () => {
  render(VoiceLobby, {
    props: {
      participants: [],
      members: [],
      media: { microphone: true, camera: false },
      joining: false,
      canJoin: false,
      hasPermission: false,
      onChange: vi.fn(),
      onJoin: vi.fn(),
    },
  });

  expect(screen.getByText(/You don't have permission to join\./)).toBeInTheDocument();
});

test('says the homeserver cannot host calls when it has no call server', () => {
  render(VoiceLobby, {
    props: {
      participants: [],
      members: [],
      media: { microphone: true, camera: false },
      joining: false,
      canJoin: false,
      hasPermission: true,
      hasFocus: false,
      onChange: vi.fn(),
      onJoin: vi.fn(),
    },
  });

  expect(screen.getByText(/This homeserver can't host calls\./)).toBeInTheDocument();
  expect(screen.queryByText(/You don't have permission to join/)).not.toBeInTheDocument();
});

function dock(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>('.dock');
  if (!element) throw new Error('no call dock');
  return within(element);
}

function mountJoinable(extra: Record<string, unknown> = {}) {
  return render(VoiceLobbyHarness, {
    props: {
      participants: ['@alice:example.org', '@bob:example.org'],
      members: [],
      media: { microphone: false, camera: false },
      joining: false,
      canJoin: true,
      hasPermission: true,
      roomName: 'Hangout',
      selfId: '@me:example.org',
      onChange: vi.fn(),
      onJoin: vi.fn(),
      ...extra,
    },
  });
}

test('lays the lobby out like the call: a tile per person and the call dock', () => {
  const { container } = mountJoinable();

  const tiles = Array.from(container.querySelectorAll('.grid > .tile'));
  expect(tiles).toHaveLength(3);
  expect(tiles[0]).toHaveTextContent('@me:example.org');
  expect(container.querySelector('.status')).toHaveTextContent('Hangout');

  const controls = dock(container);
  expect(controls.getByRole('button', { name: 'Unmute microphone' })).toHaveClass('btn-danger');
  expect(controls.queryByRole('button', { name: 'Deafen' })).not.toBeInTheDocument();
  expect(controls.queryByRole('button', { name: 'Hang up' })).not.toBeInTheDocument();
  expect(controls.getAllByRole('button', { name: /Join voice/ })).toHaveLength(1);
  expect(controls.getByRole('button', { name: /Test mic/ })).toBeInTheDocument();
});

test('joins and opens call settings from the dock', async () => {
  const onJoin = vi.fn();
  const onOpenSettings = vi.fn();
  const user = userEvent.setup();
  const { container } = mountJoinable({ onJoin, onOpenSettings });

  await user.click(dock(container).getByRole('button', { name: 'Call settings' }));
  expect(onOpenSettings).toHaveBeenCalledOnce();
  await user.click(dock(container).getByRole('button', { name: /Join voice/ }));
  expect(onJoin).toHaveBeenCalledOnce();
});

test('groups each device toggle with its menu in the dock', () => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: () => Promise.resolve([]) },
  });
  const instance = mountJoinable();

  const groups = Array.from(instance.container.querySelectorAll('.dock .group'));
  expect(groups.map((group) => group.getAttribute('data-tone'))).toEqual([
    'danger',
    'neutral',
    'neutral',
  ]);
  for (const group of groups) {
    expect(group.querySelectorAll('.device-caret')).toHaveLength(1);
    expect(group.querySelectorAll('.divider')).toHaveLength(1);
  }

  instance.unmount();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});
