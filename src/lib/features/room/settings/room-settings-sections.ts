import type { Component } from 'svelte';
import GearIcon from 'phosphor-svelte/lib/GearSixIcon';
import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
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
  | 'emojis-stickers'
  | 'developer-tools';

export interface RoomSettingsSection {
  id: RoomSettingsSectionId;
  label: string;
  icon: Component;
}

const ALL: readonly (RoomSettingsSection & { spaceOnly?: boolean })[] = [
  { id: 'general', label: 'room.settingsGeneral', icon: GearIcon },
  { id: 'members', label: 'room.settingsMembers', icon: UserIcon },
  { id: 'permissions', label: 'room.settingsPermissions', icon: LockIcon },
  { id: 'abbreviations', label: 'room.settingsAbbreviations', icon: InfoIcon },
  { id: 'appearance', label: 'room.settingsAppearance', icon: PaletteIcon, spaceOnly: true },
  { id: 'emojis-stickers', label: 'room.settingsEmojis', icon: SmileyIcon },
  { id: 'developer-tools', label: 'room.settingsDeveloper', icon: TerminalIcon },
];

export function roomSettingsSections(isSpace: boolean): readonly RoomSettingsSection[] {
  return ALL.filter((section) => !section.spaceOnly || isSpace);
}

export const DEFAULT_ROOM_SETTINGS_SECTION: RoomSettingsSectionId = 'general';
