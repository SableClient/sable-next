import { expect, test, vi } from 'vitest';

import type { InviteTriageView, RoomSummary } from '#src/generated/protocol';

import { InviteTriage, triageInvite } from './invite-triage.svelte';

function room(fields: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: '!room:example.org',
    name: 'Book club',
    topic: null,
    state: 'invited',
    latest_event: { sender: '@latest:example.org' },
    ...fields,
  } as unknown as RoomSummary;
}

function answer(fields: Partial<InviteTriageView> = {}): InviteTriageView {
  return {
    room_id: '!room:example.org',
    inviter: '@friend:example.org',
    reason: null,
    shares_room: false,
    inviter_banned: false,
    ...fields,
  };
}

const plainName = (userId: string) => userId;

test('an inviter who shares a room is known, anyone else a stranger', () => {
  expect(triageInvite(room(), answer({ shares_room: true }), plainName).group).toBe('known');
  expect(triageInvite(room(), answer(), plainName).group).toBe('strangers');
  expect(triageInvite(room(), undefined, plainName).group).toBe('strangers');
});

test('a banned inviter is spam even when they share a room', () => {
  const invite = triageInvite(
    room(),
    answer({ shares_room: true, inviter_banned: true }),
    plainName
  );
  expect(invite.group).toBe('spam');
});

test('bad words in the room, the inviter or the reason make an invite spam', () => {
  expect(triageInvite(room({ name: 'Free shit' }), answer(), plainName).group).toBe('spam');
  expect(triageInvite(room({ topic: 'torture' }), answer(), plainName).group).toBe('spam');
  expect(triageInvite(room(), answer({ reason: 'what a b!tch' }), plainName).group).toBe('spam');
  expect(triageInvite(room(), answer({ inviter: '@t0rture:example.org' }), plainName).group).toBe(
    'spam'
  );
  expect(triageInvite(room(), answer({ shares_room: true }), () => 'Shit poster').group).toBe(
    'spam'
  );
});

test('the inviter comes from the member event, falling back to the latest event', () => {
  expect(triageInvite(room(), answer(), plainName).inviter).toBe('@friend:example.org');
  expect(triageInvite(room(), undefined, plainName).inviter).toBe('@latest:example.org');
});

test('triage asks the core once per set of invites and keeps the latest answer', async () => {
  const inviteTriage = vi.fn(() => Promise.resolve([answer({ shares_room: true })]));
  const triage = new InviteTriage({ commands: { inviteTriage } } as never);
  expect(triage.ready).toBe(false);

  triage.refresh(['!b:example.org', '!room:example.org']);
  triage.refresh(['!room:example.org', '!b:example.org']);
  await vi.waitFor(() => {
    expect(triage.ready).toBe(true);
  });

  expect(inviteTriage).toHaveBeenCalledTimes(1);
  expect(triage.get('!room:example.org')?.shares_room).toBe(true);
});

test('a failed triage still lets the list render', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const triage = new InviteTriage({
    commands: { inviteTriage: () => Promise.reject(new Error('offline')) },
  } as never);

  triage.refresh(['!room:example.org']);
  await vi.waitFor(() => {
    expect(triage.ready).toBe(true);
  });
  expect(triage.get('!room:example.org')).toBeUndefined();
  warn.mockRestore();
});
