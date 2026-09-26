// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import type { CallSession } from './call-session.svelte.js';
import type { CallParticipant } from './call-transport';
import { idleTransportState } from './call-transport';
import CallViewHarness from './CallViewHarness.test.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

const screen = { id: 's', muted: false, subscribed: true };

function mountBothSharing() {
  const self: CallParticipant = { identity: 'me:AAAA', local: true, screenShare: screen };
  const other: CallParticipant = { identity: 'me:BBBB', screenShare: screen };
  const session = {
    lifecycle: 'active',
    mediaReady: true,
    failure: null,
    deviceError: null,
    connectedAt: null,
    deafened: false,
    encryptsMedia: false,
    canScreenShare: true,
    canSwitchCamera: false,
    localVideo: undefined,
    rooms: [],
    members: [
      { user_id: '@here:x', device_id: 'AAAA', identity: 'me:AAAA', backend_id: null },
      { user_id: '@there:x', device_id: 'BBBB', identity: 'me:BBBB', backend_id: null },
    ],
    transport: {
      ...idleTransportState(),
      connection: 'connected',
      self,
      participants: [other],
    },
    roomFor: () => undefined,
  } as unknown as CallSession;
  return mount(CallViewHarness, { target: document.body, props: { session, members: [] } });
}

const featured = () =>
  document.querySelector('.featured .tile')?.querySelector('.tag')?.textContent;
const pinButton = (tile: Element | null | undefined) =>
  tile?.querySelector<HTMLButtonElement>('.actions button[aria-pressed]');
const stripTiles = () => [...document.querySelectorAll('.strip .tile')];

test('pins either screen of an account sharing from two devices, and unpins to the grid', async () => {
  const instance = mountBothSharing();
  flushSync();

  expect(document.querySelector('.featured')).not.toBeNull();
  const autoFeatured = featured();
  expect(autoFeatured).toContain('@there:x');
  const featuredPin = pinButton(document.querySelector('.featured .tile'));
  expect(featuredPin?.getAttribute('aria-pressed')).toBe('true');

  const ownScreen = stripTiles().find((tile) => tile.classList.contains('screen'));
  pinButton(ownScreen)?.click();
  flushSync();
  expect(featured()).toContain('@here:x');
  expect(stripTiles().filter((tile) => tile.classList.contains('screen'))).toHaveLength(1);
  const pinnedLabel = pinButton(document.querySelector('.featured .tile'))?.getAttribute(
    'aria-label'
  );
  expect(pinnedLabel).toMatch(/^Unpin/);

  pinButton(document.querySelector('.featured .tile'))?.click();
  flushSync();
  expect(featured()).toBe(autoFeatured);

  pinButton(document.querySelector('.featured .tile'))?.click();
  flushSync();
  expect(document.querySelector('.featured')).toBeNull();
  expect(document.querySelector('.grid')).not.toBeNull();

  await unmount(instance);
});
