// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test } from 'vitest';

import type { CallSession } from './call-session.svelte.js';
import type { CallParticipant } from './call-transport';
import { idleTransportState } from './call-transport';
import CallViewHarness from './CallViewHarness.test.svelte';

const shared = { id: 's', muted: false, subscribed: true };

function mountBothSharing() {
  const self: CallParticipant = { identity: 'me:AAAA', local: true, screenShare: shared };
  const other: CallParticipant = { identity: 'me:BBBB', screenShare: shared };
  const session = {
    lifecycle: 'active',
    mediaReady: true,
    failure: null,
    deviceError: null,
    connectedAt: null,
    startedAt: null,
    deafened: false,
    encryptsMedia: false,
    canScreenShare: true,
    canSwitchCamera: false,
    localVideo: undefined,
    rooms: [],
    members: [
      {
        user_id: '@here:x',
        device_id: 'AAAA',
        identity: 'me:AAAA',
        backend_id: null,
        joined_ts: 0,
      },
      {
        user_id: '@there:x',
        device_id: 'BBBB',
        identity: 'me:BBBB',
        backend_id: null,
        joined_ts: 0,
      },
    ],
    transport: {
      ...idleTransportState(),
      connection: 'connected',
      self,
      participants: [other],
    },
    roomFor: () => undefined,
  } as unknown as CallSession;
  return render(CallViewHarness, { session, members: [] });
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
    spotlight().getByRole('button', { name: "Unpin @there:x's screen", pressed: true })
  ).toBeInTheDocument();

  await user.click(strip().getByRole('button', { name: "Pin @here:x's screen" }));
  expect(spotlight().getByRole('button', { name: "Unpin @here:x's screen" })).toBeInTheDocument();
  expect(strip().getAllByRole('button', { name: /^Pin .*'s screen$/ })).toHaveLength(1);

  await user.click(spotlight().getByRole('button', { name: "Unpin @here:x's screen" }));
  expect(spotlight().getByRole('button', { name: "Unpin @there:x's screen" })).toBeInTheDocument();

  await user.click(spotlight().getByRole('button', { name: "Unpin @there:x's screen" }));
  expect(container.querySelector('.featured')).not.toBeInTheDocument();
  expect(container.querySelector('.grid')).toBeInTheDocument();
});
