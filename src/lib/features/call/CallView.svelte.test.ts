// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('./call-telemetry', () => ({
  CallTelemetry: vi.fn(),
  safeCallCode: (code: string) => code,
}));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({ holdOverlayBack: vi.fn() }));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import type { CoreClient } from '#lib/core/client.svelte.js';

import { preferences } from '#lib/settings/preferences.svelte.js';
import { goto } from '#lib/test-support/app-navigation.js';

import { recordCallDebug } from './call-debug.svelte.js';
import { CallSession } from './call-session.svelte.js';
import { takeCallSnapshot } from './call-snapshot';
import type { CallPin } from './call-layout';
import type { CallParticipant } from './call-transport';
import { idleTransportState } from './call-transport';
import CallViewHarness from './CallViewHarness.test.svelte';

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
  Reflect.deleteProperty(document, 'fullscreenEnabled');
});

function mockBrowserFullscreen() {
  const request = vi.fn(() => Promise.resolve());
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: request,
  });
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  return request;
}

const shared = { id: 's', muted: false, subscribed: true };

function mountBothSharing(
  self: CallParticipant = { identity: 'me:AAAA', local: true, screenShare: shared },
  others: CallParticipant[] = [{ identity: 'me:BBBB', screenShare: shared }],
  otherUserId = '@there:x',
  watchedScreenShareIds = [shared.id],
  native = false
) {
  const toggleWatchScreenShare = vi.fn();
  let layout = $state.raw<CallPin>({ pinned: null, gridForced: false });
  const session = {
    lifecycle: 'active',
    mediaReady: true,
    failure: null,
    deviceError: null,
    connectedAt: null,
    startedAt: null,
    get layout() {
      return layout;
    },
    set layout(next: CallPin) {
      layout = next;
    },
    watchedScreenShareIds,
    views: 0,
    deafened: false,
    encryptsMedia: false,
    canScreenShare: true,
    canSwitchCamera: false,
    localVideo: undefined,
    remoteVideo: native
      ? { place: vi.fn(() => Promise.resolve()), clear: vi.fn(() => Promise.resolve()) }
      : undefined,
    rooms: [],
    members: [
      {
        user_id: '@here:x',
        device_id: 'AAAA',
        identity: 'me:AAAA',
        backend_id: null,
        joined_ts: 0,
        screen_sharing: false,
      },
      {
        user_id: otherUserId,
        device_id: 'BBBB',
        identity: 'me:BBBB',
        backend_id: null,
        joined_ts: 0,
        screen_sharing: false,
      },
    ],
    transport: {
      ...idleTransportState(),
      connection: 'connected',
      self,
      participants: others,
    },
    roomFor: () => undefined,
    toggleWatchScreenShare,
  } as unknown as CallSession;
  return { session, toggleWatchScreenShare, ...render(CallViewHarness, { session, members: [] }) };
}

test('pins either screen of an account sharing from two devices, and unpins to the grid', async () => {
  const user = userEvent.setup();
  const { container } = mountBothSharing();
  const spotlight = () => {
    const featured = container.querySelector<HTMLElement>('.featured');
    if (!featured) throw new Error('no featured tile');
    return within(featured);
  };
  const strip = () => within(screen.getByRole('list', { name: /participants?$/ }));

  expect(
    spotlight().getByRole('button', { name: 'Unpin @there:x’s screen', pressed: true })
  ).toBeInTheDocument();

  await user.click(strip().getByRole('button', { name: 'Pin @here:x’s screen' }));
  expect(spotlight().getByRole('button', { name: 'Unpin @here:x’s screen' })).toBeInTheDocument();
  expect(strip().getAllByRole('button', { name: /^Pin .*’s screen$/ })).toHaveLength(1);

  await user.click(spotlight().getByRole('button', { name: 'Unpin @here:x’s screen' }));
  expect(spotlight().getByRole('button', { name: 'Unpin @there:x’s screen' })).toBeInTheDocument();

  await user.click(spotlight().getByRole('button', { name: 'Unpin @there:x’s screen' }));
  expect(container.querySelector('.featured')).not.toBeInTheDocument();
  expect(container.querySelector('.grid')).toBeInTheDocument();
});

test('offers a separate tile for an available remote screen', async () => {
  const user = userEvent.setup();
  const { container, toggleWatchScreenShare } = mountBothSharing(
    { identity: 'me:AAAA', local: true },
    [{ identity: 'me:BBBB', screenShare: shared }],
    '@there:x',
    []
  );
  expect(container.querySelector('.featured')).not.toBeInTheDocument();
  expect(screen.getByText('@there:x’s screen')).toBeInTheDocument();
  expect(container.querySelector('video')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Watch @there:x’s screen' }));
  expect(toggleWatchScreenShare).toHaveBeenCalledWith('s');
});

test('stopping a pinned screen keeps other screens playing', async () => {
  const user = userEvent.setup();
  const session = new CallSession({} as CoreClient);
  session.lifecycle = 'active';
  session.mediaReady = true;
  session.transport = {
    ...idleTransportState(),
    connection: 'connected',
    self: { identity: '@here:x', local: true },
    participants: [
      { identity: '@there:x', screenShare: shared },
      { identity: '@another:x', screenShare: { ...shared, id: 'other' } },
    ],
  };
  const { container } = render(CallViewHarness, { session, members: [] });

  expect(screen.getByText('@there:x’s screen')).toBeInTheDocument();
  expect(container.querySelector('video')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Watch @there:x’s screen' }));
  expect(container.querySelector('.featured video')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Watch @another:x’s screen' }));
  expect(container.querySelectorAll('.featured video')).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Pin @there:x’s screen' }));
  await user.click(screen.getByRole('button', { name: 'Stop watching @there:x’s screen' }));
  expect(screen.getByText('@there:x’s screen')).toBeInTheDocument();
  expect(container.querySelectorAll('video')).toHaveLength(1);
  expect(
    screen.getByRole('button', { name: 'Stop watching @another:x’s screen' })
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Stop watching @another:x’s screen' }));
  expect(container.querySelector('video')).not.toBeInTheDocument();
  expect(container.querySelector('.featured')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Watch @there:x’s screen' }));
  expect(container.querySelector('.featured video')).toBeInTheDocument();

  session.transport = {
    ...session.transport,
    participants: [{ identity: '@another:x', screenShare: { ...shared, id: 'other' } }],
  };
  await vi.waitFor(() => {
    expect(screen.queryByText('@there:x’s screen')).not.toBeInTheDocument();
    expect(container.querySelector('video')).not.toBeInTheDocument();
  });
});

test('features every remote screen together and keeps the people in the strip', () => {
  const { container } = mountBothSharing({ identity: 'me:AAAA', local: true }, [
    { identity: 'me:BBBB', screenShare: shared },
    { identity: 'me:CCCC', screenShare: shared },
  ]);
  const featured = container.querySelector<HTMLElement>('ul.featured');
  if (!featured) throw new Error('no featured list');

  expect(within(featured).getAllByRole('listitem')).toHaveLength(2);
  expect(featured).toHaveClass('several');
  expect(
    within(screen.getByRole('list', { name: /participants?$/ })).getAllByRole('listitem')
  ).toHaveLength(3);
});

test('a pin outlives the call view closing and opening again', async () => {
  const user = userEvent.setup();
  const first = mountBothSharing();
  await user.click(
    within(screen.getByRole('list', { name: /participants?$/ })).getByRole('button', {
      name: 'Pin @here:x’s screen',
    })
  );
  const { session } = first;
  first.unmount();

  const { container } = render(CallViewHarness, { session, members: [] });
  const featured = container.querySelector<HTMLElement>('ul.featured');
  if (!featured) throw new Error('no featured list');
  expect(
    within(featured).getByRole('button', { name: 'Unpin @here:x’s screen' })
  ).toBeInTheDocument();
});

test('two devices of one account are told apart by device', () => {
  mountBothSharing(undefined, undefined, '@here:x');

  expect(screen.getByText('@here:x (this device)’s screen')).toBeInTheDocument();
  expect(screen.getByText('@here:x (BBBB)’s screen')).toBeInTheDocument();
});

test('the call view counts itself as watching while it is on screen', () => {
  const { session, unmount } = mountBothSharing();
  expect(session.views).toBe(1);
  unmount();
  expect(session.views).toBe(0);
});

test('exits native fullscreen before opening call settings', async () => {
  const request = mockBrowserFullscreen();
  const { container, session, rerender, unmount } = mountBothSharing(
    undefined,
    undefined,
    undefined,
    undefined,
    true
  );
  const stage = screen.getByRole('region', { name: 'Call' });
  const user = userEvent.setup();
  await user.click(within(stage).getAllByRole('button', { name: 'Full screen' })[0]);
  expect(request).not.toHaveBeenCalled();
  expect(stage.parentElement).toBe(document.body);
  expect(stage).toHaveClass('expanded');

  const onOpenSettings = vi.fn();
  await rerender({ session, members: [], onOpenSettings });
  await user.click(screen.getByRole('button', { name: 'Call settings' }));
  expect(onOpenSettings).toHaveBeenCalledOnce();
  expect(container).toContainElement(stage);
  expect(stage).not.toHaveClass('expanded');

  await user.click(within(stage).getAllByRole('button', { name: 'Full screen' })[0]);
  unmount();
  expect(stage).not.toBeInTheDocument();
});

test('web call fullscreen still uses the browser API', async () => {
  const request = mockBrowserFullscreen();
  mountBothSharing();
  const stage = screen.getByRole('region', { name: 'Call' });
  await userEvent.setup().click(within(stage).getAllByRole('button', { name: 'Full screen' })[0]);
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.instances[0]).toBe(stage);
});

test('the debug overlay follows its own switch under developer tools', () => {
  preferences.developerTools = true;
  recordCallDebug({
    requested: 'auto',
    mode: 'compatibility',
    reason: undefined,
    stickyAvailable: undefined,
    peerModes: [],
    transport: 'livekit-web',
    backendCount: 1,
    encrypted: false,
  });
  try {
    preferences.callDebugOverlay = false;
    const hidden = mountBothSharing();
    expect(screen.queryByLabelText('Call mode debug')).not.toBeInTheDocument();
    hidden.unmount();

    preferences.callDebugOverlay = true;
    mountBothSharing();
    expect(screen.getByLabelText('Call mode debug')).toBeInTheDocument();
  } finally {
    recordCallDebug(null);
    preferences.developerTools = false;
    preferences.callDebugOverlay = true;
  }
});

test('reporting a problem from a call opens the bug report with a call snapshot', async () => {
  mountBothSharing();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Report a problem' }));
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledOnce();
  });
  expect(takeCallSnapshot()).toMatchObject({ lifecycle: 'active', members: 2, participants: 1 });
});
