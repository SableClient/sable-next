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

test('offers a single join button with the device preview underneath', async () => {
  const instance = mount(VoiceLobbyHarness, {
    target: document.body,
    props: {
      participants: [],
      members: [],
      media: { microphone: true, camera: false },
      joining: false,
      canJoin: true,
      hasPermission: true,
      onChange: vi.fn(),
      onJoin: vi.fn(),
    },
  });
  await tick();

  const join = Array.from(document.querySelectorAll('button')).filter((node) =>
    node.textContent.includes('Join voice')
  );
  expect(join).toHaveLength(1);
  expect(document.body.textContent).not.toContain('Check devices');
  const preview = document.querySelector('.prescreen');
  expect(preview).not.toBeNull();
  expect(
    join[0].compareDocumentPosition(preview as Node) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(document.querySelectorAll('button[aria-label="Mute microphone"]')).toHaveLength(1);

  await unmount(instance);
});
