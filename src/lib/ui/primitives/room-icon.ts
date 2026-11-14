import type { Component } from 'svelte';
import GlobeSimpleIcon from 'phosphor-svelte/lib/GlobeSimpleIcon';
import ChatsCircleIcon from 'phosphor-svelte/lib/ChatsCircleIcon';
import CalendarDotsIcon from 'phosphor-svelte/lib/CalendarDotsIcon';
import HashStraightIcon from 'phosphor-svelte/lib/HashStraightIcon';
import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
import GavelIcon from 'phosphor-svelte/lib/GavelIcon';

import type { RoomKind, RoomJoinRuleView } from '#src/generated/protocol';

export type RoomIconOverlay = 'globe' | 'lock';

export type RoomIconShape = {
  roomKind: RoomKind | null;
  hasParent: boolean;
  joinRule: RoomJoinRuleView | null;
};

function isPrivate(joinRule: RoomJoinRuleView | null): boolean {
  return joinRule === 'invite' || joinRule === 'knock' || joinRule === 'private';
}

export function roomIconOverlay(room: RoomIconShape): RoomIconOverlay | null {
  // Sable's room list is organized around spaces.
  // We assume that most rooms in a space are going to be restricted to the space
  // by default, so we don't show an icon overlay for those rooms.
  // We show a globe for explicitly public rooms and a lock for explicitly private rooms.
  // For rooms outside a space, we always show either a globe or a lock.
  // For spaces, we only show a lock if they're private, since spaces are usually public by default.

  if (room.roomKind === null) {
    return null;
  }

  if (room.joinRule === 'public' && room.roomKind !== 'space') {
    return 'globe';
  } else if (!(room.hasParent || room.roomKind === 'space') || isPrivate(room.joinRule)) {
    return 'lock';
  } else {
    return null;
  }
}

export function roomIconOverlayComponent(overlay: RoomIconOverlay): Component {
  return overlay === 'globe' ? GlobeSimpleIcon : LockSimpleIcon;
}

export function roomIconComponent(room: RoomIconShape): Component {
  switch (room.roomKind) {
    case 'text':
      return HashStraightIcon;
    case 'space':
      return SquaresFourIcon;
    case 'voice':
      return SpeakerHighIcon;
    case 'forum':
      return ChatsCircleIcon;
    case 'calendar':
      return CalendarDotsIcon;
    case 'policy':
      return GavelIcon;
    default:
      return QuestionIcon;
  }
}

export function roomIconWeight(
  room: RoomIconShape,
  weight: 'regular' | 'fill'
): 'regular' | 'fill' | 'bold' {
  return weight === 'fill' && roomIconComponent(room) === HashStraightIcon ? 'bold' : weight;
}
