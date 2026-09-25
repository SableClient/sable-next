import type { Component } from 'svelte';

import type {
  MembershipChangeView,
  StateChangeView,
  TimelineItemView,
} from '#src/generated/protocol';

import AtIcon from 'phosphor-svelte/lib/AtIcon';
import EnvelopeSimpleIcon from 'phosphor-svelte/lib/EnvelopeSimpleIcon';
import HashIcon from 'phosphor-svelte/lib/HashIcon';
import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
import PhoneDisconnectIcon from 'phosphor-svelte/lib/PhoneDisconnectIcon';
import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
import SignInIcon from 'phosphor-svelte/lib/SignInIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
import UserIcon from 'phosphor-svelte/lib/UserIcon';
import UserMinusIcon from 'phosphor-svelte/lib/UserMinusIcon';
import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
import WarningIcon from 'phosphor-svelte/lib/WarningIcon';

import { isEditEvent } from './timeline-event-index';

const MEMBERSHIP_ICONS: Record<MembershipChangeView, Component> = {
  invited: UserPlusIcon,
  knock_accepted: UserPlusIcon,
  knocked: EnvelopeSimpleIcon,
  joined: SignInIcon,
  invitation_accepted: SignInIcon,
  invitation_rejected: UserMinusIcon,
  invitation_revoked: UserMinusIcon,
  knock_retracted: UserMinusIcon,
  knock_denied: UserMinusIcon,
  left: SignOutIcon,
  kicked: SignOutIcon,
  kicked_and_banned: SignOutIcon,
  banned: SignOutIcon,
  unbanned: SignOutIcon,
  other: UserIcon,
};

function stateChangeIcon(change: StateChangeView): Component {
  switch (change.kind) {
    case 'room_name':
    case 'room_topic':
    case 'room_avatar':
      return HashIcon;
    case 'pinned_events':
      return PushPinIcon;
    case 'call_membership':
      return change.joined ? PhoneIcon : PhoneDisconnectIcon;
  }
}

function hiddenEventIcon(item: TimelineItemView): Component {
  if (item.content.kind !== 'hidden_event') return CodeIcon;
  if (item.content.event_type === 'm.reaction') return SmileyIcon;
  if (item.content.event_type === 'm.room.redaction') return TrashIcon;
  return isEditEvent(item) ? PencilSimpleIcon : CodeIcon;
}

export function stateEventIcon(item: TimelineItemView): Component {
  const content = item.content;
  switch (content.kind) {
    case 'membership':
      return MEMBERSHIP_ICONS[content.change];
    case 'profile_change':
      return content.display_name ? AtIcon : UserIcon;
    case 'state_event':
      return content.change ? stateChangeIcon(content.change) : HashIcon;
    case 'call_invite':
      return PhoneIcon;
    case 'redacted':
      return TrashIcon;
    case 'hidden_event':
      return hiddenEventIcon(item);
    default:
      return WarningIcon;
  }
}
