// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import type { CallSession } from './call-session.svelte.js';
import type { CallParticipant } from './call-transport';
import { idleTransportState } from './call-transport';
import { dismissedPreview } from './screen-share-preview.svelte.js';
import ScreenSharePreview from './ScreenSharePreview.svelte';

const shared = { id: 's', muted: false, subscribed: true };

const track = { attach: vi.fn(), detach: vi.fn() };

beforeEach(() => {
  track.attach.mockClear();
  track.detach.mockClear();
  Object.assign(core, {
    userProfile: vi.fn(() => Promise.resolve({ display_name: 'Alice' })),
  });
  dismissedPreview.key = null;
});

function session(participants: CallParticipant[], withRoom = true): CallSession {
  const room = {
    remoteParticipants: new Map(
      participants.map((participant) => [
        participant.identity,
        { getTrackPublication: () => ({ track }) },
      ])
    ),
  };
  return {
    layout: { pinned: null, gridForced: false },
    watchedScreenShareIds: [shared.id],
    members: [
      { user_id: '@alice:x', device_id: 'A', identity: 'alice:A', backend_id: null, joined_ts: 0 },
    ],
    transport: { ...idleTransportState(), self: { identity: 'me:M', local: true }, participants },
    roomFor: () => (withRoom ? room : undefined),
  } as unknown as CallSession;
}

test('previews a remote screen and returns to the call when its name is pressed', async () => {
  const onReturn = vi.fn();
  render(ScreenSharePreview, {
    session: session([{ identity: 'alice:A', screenShare: shared }]),
    onReturn,
  });

  const name = await screen.findByRole('button', { name: "Alice's screen" });
  await userEvent.setup().click(name);

  expect(onReturn).toHaveBeenCalledOnce();
});

test('attaches the screen through LiveKit so adaptive stream keeps it playing', () => {
  const { container, unmount } = render(ScreenSharePreview, {
    session: session([{ identity: 'alice:A', screenShare: shared }]),
    onReturn: vi.fn(),
  });
  const video = container.querySelector('video');

  expect(track.attach).toHaveBeenCalledWith(video);
  unmount();
  expect(track.detach).toHaveBeenCalledWith(video);
});

test('hiding the preview keeps it hidden for that share', async () => {
  const user = userEvent.setup();
  render(ScreenSharePreview, {
    session: session([{ identity: 'alice:A', screenShare: shared }]),
    onReturn: vi.fn(),
  });

  await user.click(await screen.findByRole('button', { name: 'Hide the shared screen' }));

  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});

test('shows nothing without a remote screen or a room to draw it from', () => {
  const { unmount } = render(ScreenSharePreview, {
    session: session([{ identity: 'alice:A' }]),
    onReturn: vi.fn(),
  });
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  unmount();

  render(ScreenSharePreview, {
    session: session([{ identity: 'alice:A', screenShare: shared }], false),
    onReturn: vi.fn(),
  });
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});
