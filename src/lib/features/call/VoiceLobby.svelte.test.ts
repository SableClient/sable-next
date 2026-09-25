// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import VoiceLobby from './VoiceLobby.svelte';
import VoiceLobbyHarness from './VoiceLobbyHarness.test.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('hides the permission error when a call service is unavailable', async () => {
  const instance = mount(VoiceLobby, {
    target: document.body,
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
  await tick();

  expect(document.body.textContent).not.toContain("You don't have permission to join.");
  expect(document.querySelector('button')).toBeNull();

  await unmount(instance);
});

test('shows the permission error when joining is forbidden', async () => {
  const instance = mount(VoiceLobby, {
    target: document.body,
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
  await tick();

  expect(document.querySelector('.alert-warning')?.textContent).toContain(
    "You don't have permission to join."
  );

  await unmount(instance);
});

test('says the homeserver cannot host calls when it has no call server', async () => {
  const instance = mount(VoiceLobby, {
    target: document.body,
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
  await tick();

  expect(document.querySelector('.alert-warning')?.textContent).toContain(
    "This homeserver can't host calls."
  );
  expect(document.body.textContent).not.toContain("You don't have permission to join.");

  await unmount(instance);
});

function mountJoinable(extra: Record<string, unknown> = {}) {
  return mount(VoiceLobbyHarness, {
    target: document.body,
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

test('lays the lobby out like the call: a tile per person and the call dock', async () => {
  const instance = mountJoinable();
  await tick();

  const tiles = Array.from(document.querySelectorAll('.grid > .tile'));
  expect(tiles).toHaveLength(3);
  expect(tiles[0].textContent).toContain('@me:example.org');
  expect(document.querySelector('.status')?.textContent).toContain('Hangout');

  const dock = document.querySelector('.dock .controls');
  expect(dock).not.toBeNull();
  expect(dock?.querySelector('button[aria-label="Unmute microphone"]')?.classList).toContain(
    'btn-danger'
  );
  expect(dock?.querySelector('button[aria-label="Deafen"]')).toBeNull();
  expect(dock?.querySelector('button[aria-label="Hang up"]')).toBeNull();
  const join = Array.from(dock?.querySelectorAll('button') ?? []).filter((node) =>
    node.textContent.includes('Join voice')
  );
  expect(join).toHaveLength(1);
  expect(dock?.textContent).toContain('Test mic');

  await unmount(instance);
});

test('joins and opens call settings from the dock', async () => {
  const onJoin = vi.fn();
  const onOpenSettings = vi.fn();
  const instance = mountJoinable({ onJoin, onOpenSettings });
  await tick();

  const dock = document.querySelector('.dock');
  dock?.querySelector<HTMLButtonElement>('button[aria-label="Call settings"]')?.click();
  expect(onOpenSettings).toHaveBeenCalledOnce();
  Array.from(dock?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    .find((node) => node.textContent.includes('Join voice'))
    ?.click();
  expect(onJoin).toHaveBeenCalledOnce();

  await unmount(instance);
});

test('groups each device toggle with its menu in the dock', async () => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { enumerateDevices: () => Promise.resolve([]) },
  });
  const instance = mountJoinable();
  await tick();

  const groups = Array.from(document.querySelectorAll('.dock .group'));
  expect(groups.map((group) => group.getAttribute('data-tone'))).toEqual([
    'danger',
    'neutral',
    'neutral',
  ]);
  for (const group of groups) {
    expect(group.querySelectorAll('.device-caret')).toHaveLength(1);
    expect(group.querySelectorAll('.divider')).toHaveLength(1);
  }

  await unmount(instance);
  Reflect.deleteProperty(navigator, 'mediaDevices');
});
