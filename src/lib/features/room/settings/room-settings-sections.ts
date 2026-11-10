import type { Component } from 'svelte';
import BridgeIcon from 'phosphor-svelte/lib/BridgeIcon';
import GearIcon from 'phosphor-svelte/lib/GearSixIcon';
import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
import PaintBrushIcon from 'phosphor-svelte/lib/PaintBrushIcon';
import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';
import LockIcon from 'phosphor-svelte/lib/LockIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import TerminalIcon from 'phosphor-svelte/lib/TerminalIcon';
import UserIcon from 'phosphor-svelte/lib/UserIcon';

export type RoomSettingsSectionId =
  | 'general'
  | 'members'
  | 'permissions'
  | 'abbreviations'
  | 'appearance'
  | 'bridges'
  | 'cosmetics'
  | 'emojis-stickers'
  | 'developer-tools';

export interface RoomSettingsSection {
  id: RoomSettingsSectionId;
  label: string;
  icon: Component;
}

const ALL: readonly (RoomSettingsSection & { spaceOnly?: boolean; bridgedOnly?: boolean })[] = [
  { id: 'general', label: 'room.settingsGeneral', icon: GearIcon },
  { id: 'members', label: 'room.settingsMembers', icon: UserIcon },
  { id: 'permissions', label: 'room.settingsPermissions', icon: LockIcon },
  { id: 'abbreviations', label: 'room.settingsAbbreviations', icon: InfoIcon },
  { id: 'appearance', label: 'room.settingsAppearance', icon: PaletteIcon, spaceOnly: true },
  { id: 'bridges', label: 'room.settingsBridges', icon: BridgeIcon, bridgedOnly: true },
  { id: 'cosmetics', label: 'room.settingsCosmetics', icon: PaintBrushIcon },
  { id: 'emojis-stickers', label: 'room.settingsEmojis', icon: SmileyIcon },
  { id: 'developer-tools', label: 'common.developerTools', icon: TerminalIcon },
];

export function roomSettingsSections(
  isSpace: boolean,
  bridged: boolean
): readonly RoomSettingsSection[] {
  return ALL.filter(
    (section) => (!section.spaceOnly || isSpace) && (!section.bridgedOnly || bridged)
  );
}

export const DEFAULT_ROOM_SETTINGS_SECTION: RoomSettingsSectionId = 'general';
