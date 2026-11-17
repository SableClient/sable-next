import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('./call-telemetry', () => ({ CallTelemetry: vi.fn() }));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import type { CallSession } from './call-session.svelte.js';
import { idleTransportState } from './call-transport';
import CallViewHarness from './CallViewHarness.test.svelte';

afterEach(() => vi.restoreAllMocks());

function activeCall(): CallSession {
  const overlay = { place: vi.fn(() => Promise.resolve()), clear: vi.fn(() => Promise.resolve()) };
  const track = { id: 'camera', muted: false, subscribed: true };
  return {
    lifecycle: 'active',
    mediaReady: true,
    failure: null,
    deviceError: null,
    startedAt: null,
    layout: { pinned: null, gridForced: false },
    watchedScreenShareIds: [],
    views: 0,
    deafened: false,
    microphoneEnabled: true,
    inputMode: 'voice-activity',
    encryptsMedia: false,
    canScreenShare: true,
    canSwitchCamera: true,
    audioRoutes: { list: () => Promise.resolve([]), select: () => Promise.resolve() },
    localVideo: overlay,
    remoteVideo: overlay,
    rooms: [],
    members: [],
    transport: {
      ...idleTransportState(),
      connection: 'connected',
      microphoneEnabled: true,
      self: { identity: 'me', local: true },
      participants: [{ identity: 'bob', camera: track, microphone: track }],
    },
    roomFor: () => undefined,
  } as unknown as CallSession;
}

async function renderCall() {
  const { container } = await render(CallViewHarness, {
    session: activeCall(),
    members: [],
    onOpenSettings: vi.fn(),
  });
  container.style.cssText = 'display:flex;width:402px;height:700px';
  return container;
}

test('a remote camera stays clear of the controls when they wrap on a phone', async () => {
  await page.viewport(402, 874);
  const container = await renderCall();
  const controls = container.querySelector<HTMLElement>('.dock .controls');
  const video = container.querySelector<HTMLElement>('.tile .video');
  if (!controls || !video) throw new Error('call not rendered');

  await expect.poll(() => video.getBoundingClientRect().height).toBeGreaterThan(0);
  await expect
    .poll(() => controls.getBoundingClientRect().top - video.getBoundingClientRect().bottom)
    .toBeGreaterThanOrEqual(0);
});

test('resting controls give their space back to the video', async () => {
  await page.viewport(402, 874);
  const container = await renderCall();
  const stage = container.querySelector<HTMLElement>('.stage');
  const video = container.querySelector<HTMLElement>('.tile .video');
  if (!stage || !video) throw new Error('call not rendered');
  await expect.poll(() => video.getBoundingClientRect().height).toBeGreaterThan(0);
  const awake = video.getBoundingClientRect().height;

  stage.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));

  await expect.poll(() => stage.classList.contains('resting')).toBe(true);
  await expect.poll(() => video.getBoundingClientRect().height).toBeGreaterThan(awake);
});
