import { afterEach, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('./call-telemetry', () => ({ CallTelemetry: vi.fn() }));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import type { CallSession } from './call-session.svelte.js';
import { idleTransportState, type CallParticipant } from './call-transport';
import CallViewHarness from './CallViewHarness.test.svelte';

afterEach(() => vi.restoreAllMocks());

const track = { id: 'camera', muted: false, subscribed: true };
const share = { id: 'share', muted: false, subscribed: true };

function activeCall({
  nativeVideo = true,
  participants = [{ identity: 'bob', camera: track, microphone: track }],
  watchedScreenShareIds = [],
}: {
  nativeVideo?: boolean;
  participants?: CallParticipant[];
  watchedScreenShareIds?: string[];
} = {}): CallSession {
  const overlay = { place: vi.fn(() => Promise.resolve()), clear: vi.fn(() => Promise.resolve()) };
  return {
    lifecycle: 'active',
    mediaReady: true,
    failure: null,
    deviceError: null,
    startedAt: null,
    layout: { pinned: null, gridForced: false },
    watchedScreenShareIds,
    views: 0,
    deafened: false,
    microphoneEnabled: true,
    inputMode: 'voice-activity',
    encryptsMedia: false,
    canScreenShare: true,
    canSwitchCamera: true,
    audioRoutes: { list: () => Promise.resolve([]), select: () => Promise.resolve() },
    localVideo: nativeVideo ? overlay : undefined,
    remoteVideo: nativeVideo ? overlay : undefined,
    rooms: [],
    members: [],
    transport: {
      ...idleTransportState(),
      connection: 'connected',
      microphoneEnabled: true,
      self: { identity: 'me', local: true },
      participants,
    },
    roomFor: () => undefined,
    toggleWatchScreenShare: vi.fn(),
  } as unknown as CallSession;
}

async function renderCall(session = activeCall()) {
  const { container } = await render(CallViewHarness, {
    session,
    members: [],
    onOpenSettings: vi.fn(),
  });
  container.style.cssText = 'display:flex;width:402px;height:700px';
  return container;
}

test('the wrapped controls dock floats inside the stage without reserving space below the video', async () => {
  await page.viewport(402, 874);
  const container = await renderCall(activeCall({ nativeVideo: false }));
  const stage = container.querySelector<HTMLElement>('.stage');
  const controls = container.querySelector<HTMLElement>('.dock .controls');
  const video = container.querySelector<HTMLElement>('.tile .video');
  if (!stage || !controls || !video) throw new Error('call not rendered');

  await expect.poll(() => video.getBoundingClientRect().height).toBeGreaterThan(0);
  const stageBox = stage.getBoundingClientRect();
  const controlsBox = controls.getBoundingClientRect();
  expect(controlsBox.left).toBeGreaterThanOrEqual(stageBox.left);
  expect(controlsBox.right).toBeLessThanOrEqual(stageBox.right);
  expect(controlsBox.bottom).toBeLessThanOrEqual(stageBox.bottom);
  expect(video.getBoundingClientRect().bottom).toBeGreaterThan(controlsBox.top);
});

test('a native camera view on a phone stays clear of the controls dock', async () => {
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

test.each([
  [390, 844],
  [360, 800],
])(
  'waking the resting stage at %ix%i leaves stop watching clear of the status',
  async (width, height) => {
    await page.viewport(width, height);
    const container = await renderCall(
      activeCall({
        participants: [{ identity: 'bob', camera: track, microphone: track, screenShare: share }],
        watchedScreenShareIds: [share.id],
      })
    );
    const stage = container.querySelector<HTMLElement>('.stage');
    const status = container.querySelector<HTMLElement>('.status');
    const stop = container.querySelector<HTMLElement>('.stop-watching button');
    if (!stage || !status || !stop) throw new Error('call not rendered');

    stage.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    await expect.poll(() => stage.classList.contains('resting')).toBe(true);
    const resting = stop.getBoundingClientRect();

    stop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
    await expect.poll(() => stage.classList.contains('resting')).toBe(false);

    const statusBox = status.getBoundingClientRect();
    const stopBox = stop.getBoundingClientRect();
    expect(stopBox.toJSON()).toEqual(resting.toJSON());
    const hit = document.elementFromPoint(
      stopBox.left + stopBox.width / 2,
      stopBox.top + stopBox.height / 2
    );
    expect(hit !== null && stop.contains(hit)).toBe(true);
    expect(
      statusBox.bottom <= stopBox.top ||
        stopBox.bottom <= statusBox.top ||
        statusBox.right <= stopBox.left ||
        stopBox.right <= statusBox.left
    ).toBe(true);
  }
);
