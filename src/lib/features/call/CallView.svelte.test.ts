// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test } from 'vitest';

import type { CallSession } from './call-session.svelte.js';
import type { CallParticipant } from './call-transport';
import { idleTransportState } from './call-transport';
import CallViewHarness from './CallViewHarness.test.svelte';

const shared = { id: 's', muted: false, subscribed: true };

function mountBothSharing(
  self: CallParticipant = { identity: 'me:AAAA', local: true, screenShare: shared },
  others: CallParticipant[] = [{ identity: 'me:BBBB', screenShare: shared }],
  otherUserId = '@there:x'
) {
  const session = {
    lifecycle: 'active',
    mediaReady: true,
    failure: null,
    deviceError: null,
    connectedAt: null,
    startedAt: null,
    layout: { pinned: null, gridForced: false },
    views: 0,
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
        user_id: otherUserId,
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
      participants: others,
    },
    roomFor: () => undefined,
  } as unknown as CallSession;
  return { session, ...render(CallViewHarness, { session, members: [] }) };
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
      name: "Pin @here:x's screen",
    })
  );
  const { session } = first;
  first.unmount();

  const { container } = render(CallViewHarness, { session, members: [] });
  const featured = container.querySelector<HTMLElement>('ul.featured');
  if (!featured) throw new Error('no featured list');
  expect(
    within(featured).getByRole('button', { name: "Unpin @here:x's screen" })
  ).toBeInTheDocument();
});

test('two devices of one account are told apart by device', () => {
  mountBothSharing(undefined, undefined, '@here:x');

  expect(screen.getByText("@here:x (this device)'s screen")).toBeInTheDocument();
  expect(screen.getByText("@here:x (BBBB)'s screen")).toBeInTheDocument();
});

test('the call view counts itself as watching while it is on screen', () => {
  const { session, unmount } = mountBothSharing();
  expect(session.views).toBe(1);
  unmount();
  expect(session.views).toBe(0);
});
