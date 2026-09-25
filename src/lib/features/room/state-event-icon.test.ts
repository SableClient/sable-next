import { expect, test } from 'vitest';

import type {
  MembershipChangeView,
  StateChangeView,
  TimelineItemView,
} from '#src/generated/protocol';

import AtIcon from 'phosphor-svelte/lib/AtIcon';
import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
import EnvelopeSimpleIcon from 'phosphor-svelte/lib/EnvelopeSimpleIcon';
import HashIcon from 'phosphor-svelte/lib/HashIcon';
import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
import PhoneDisconnectIcon from 'phosphor-svelte/lib/PhoneDisconnectIcon';
import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
import SignInIcon from 'phosphor-svelte/lib/SignInIcon';
import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
import UserIcon from 'phosphor-svelte/lib/UserIcon';
import UserMinusIcon from 'phosphor-svelte/lib/UserMinusIcon';
import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
import WarningIcon from 'phosphor-svelte/lib/WarningIcon';

import { stateEventIcon } from './state-event-icon';

function membership(change: MembershipChangeView): TimelineItemView {
  return {
    content: {
      kind: 'membership',
      user_id: '@bob:example.org',
      change,
      display_name: null,
      reason: null,
    },
  } as TimelineItemView;
}

function stateEvent(change: StateChangeView | null): TimelineItemView {
  return {
    content: {
      kind: 'state_event',
      event_type: 'm.room.name',
      state_key: '',
      content: null,
      change,
    },
  } as TimelineItemView;
}

test('a membership transition takes v1 icon for arriving, knocking and leaving', () => {
  expect(stateEventIcon(membership('invited'))).toBe(UserPlusIcon);
  expect(stateEventIcon(membership('knock_accepted'))).toBe(UserPlusIcon);
  expect(stateEventIcon(membership('knocked'))).toBe(EnvelopeSimpleIcon);
  expect(stateEventIcon(membership('joined'))).toBe(SignInIcon);
  expect(stateEventIcon(membership('invitation_accepted'))).toBe(SignInIcon);
  expect(stateEventIcon(membership('invitation_rejected'))).toBe(UserMinusIcon);
  expect(stateEventIcon(membership('knock_denied'))).toBe(UserMinusIcon);
  expect(stateEventIcon(membership('kicked'))).toBe(SignOutIcon);
  expect(stateEventIcon(membership('banned'))).toBe(SignOutIcon);
  expect(stateEventIcon(membership('other'))).toBe(UserIcon);
});

test('a profile change separates a rename from an avatar change', () => {
  const profile = (displayName: { old: string; new: string } | null): TimelineItemView =>
    ({
      content: {
        kind: 'profile_change',
        user_id: '@bob:example.org',
        display_name: displayName,
        avatar: displayName === null ? { old: 'mxc://a/b', new: null } : null,
      },
    }) as TimelineItemView;

  expect(stateEventIcon(profile({ old: 'Bob', new: 'Bobby' }))).toBe(AtIcon);
  expect(stateEventIcon(profile(null))).toBe(UserIcon);
});

test('a room change takes its icon from the change, not from the event type', () => {
  expect(stateEventIcon(stateEvent({ kind: 'room_name', name: 'General', previous: null }))).toBe(
    HashIcon
  );
  expect(
    stateEventIcon(stateEvent({ kind: 'pinned_events', added: [], removed: [], total: 1 }))
  ).toBe(PushPinIcon);
  expect(stateEventIcon(stateEvent({ kind: 'call_membership', joined: true }))).toBe(PhoneIcon);
  expect(stateEventIcon(stateEvent({ kind: 'call_membership', joined: false }))).toBe(
    PhoneDisconnectIcon
  );
  expect(stateEventIcon(stateEvent(null))).toBe(HashIcon);
});

test('a redaction and an unreadable event are distinguishable', () => {
  expect(stateEventIcon({ content: { kind: 'redacted', reason: null } } as TimelineItemView)).toBe(
    TrashIcon
  );
  expect(
    stateEventIcon({ content: { kind: 'malformed', event_type: 'x' } } as TimelineItemView)
  ).toBe(WarningIcon);
});

test('a hidden aggregation takes the icon of what it did', () => {
  const hidden = (eventType: string, content: unknown): TimelineItemView =>
    ({
      content: { kind: 'hidden_event', event_type: eventType, content, redacts: null },
    }) as TimelineItemView;

  expect(stateEventIcon(hidden('m.reaction', {}))).toBe(SmileyIcon);
  expect(stateEventIcon(hidden('m.room.redaction', {}))).toBe(TrashIcon);
  expect(
    stateEventIcon(
      hidden('m.room.message', { 'm.relates_to': { rel_type: 'm.replace', event_id: '$m' } })
    )
  ).toBe(PencilSimpleIcon);
  expect(stateEventIcon(hidden('org.example.custom', {}))).toBe(CodeIcon);
});
