// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import type { CallSession } from './call-session.svelte.js';
import type { CallParticipant } from './call-transport';
import { idleTransportState } from './call-transport';
import { dismissedPreview } from './screen-share-preview.svelte.js';
import ScreenSharePreview from './ScreenSharePreview.svelte';

const shared = { id: 's', muted: false, subscribed: true };

beforeEach(() => {
  vi.stubGlobal(
    'MediaStream',
    class {
      constructor(readonly tracks: unknown[]) {}
    }
  );
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get: () => null,
    set: () => {},
  });
  Object.assign(core, {
    userProfile: vi.fn(() => Promise.resolve({ display_name: 'Alice' })),
  });
  dismissedPreview.key = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function session(participants: CallParticipant[], withRoom = true): CallSession {
  const room = {
    remoteParticipants: new Map(
      participants.map((participant) => [
        participant.identity,
        { getTrackPublication: () => ({ track: { mediaStreamTrack: {} } }) },
      ])
    ),
  };
  return {
    layout: { pinned: null, gridForced: false },
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
