import type { Component } from 'svelte';
import GlobeSimpleIcon from 'phosphor-svelte/lib/GlobeSimpleIcon';
import HashStraightIcon from 'phosphor-svelte/lib/HashStraightIcon';
import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';

import type { RoomJoinRuleView } from '#src/generated/protocol';

export type RoomIconOverlay = 'globe' | 'lock';

export type RoomIconShape = {
  isSpace?: boolean;
  isVoice?: boolean;
  joinRule?: RoomJoinRuleView | null;
};

function isRestricted(joinRule: RoomJoinRuleView | null | undefined): boolean {
  return joinRule === 'invite' || joinRule === 'knock' || joinRule === 'private';
}

export function roomIconOverlay(room: RoomIconShape): RoomIconOverlay | undefined {
  if (room.isSpace === true || room.isVoice === true) return undefined;
  if (room.joinRule === 'public') return 'globe';
  if (isRestricted(room.joinRule)) return 'lock';
  return undefined;
}

export function roomIconOverlayComponent(overlay: RoomIconOverlay): Component {
  return overlay === 'globe' ? GlobeSimpleIcon : LockSimpleIcon;
}

export function roomIconComponent(room: RoomIconShape): Component {
  if (room.isSpace === true) {
    if (room.joinRule === 'public') return GlobeSimpleIcon;
    if (isRestricted(room.joinRule)) return LockSimpleIcon;
    return SquaresFourIcon;
  }

  if (room.isVoice === true) {
    if (room.joinRule === 'public') return GlobeSimpleIcon;
    if (isRestricted(room.joinRule)) return LockSimpleIcon;
    return SpeakerHighIcon;
  }

  return HashStraightIcon;
}
