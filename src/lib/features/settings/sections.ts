import type { Component } from 'svelte';
import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
import KeyboardIcon from 'phosphor-svelte/lib/KeyboardIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import LockKeyIcon from 'phosphor-svelte/lib/LockKeyIcon';
import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';

import {
  SETTINGS_ACCOUNT_SECTION,
  SETTINGS_DEVICES_SECTION,
  SETTINGS_EMOTES_SECTION,
} from '#lib/settings/registry.js';

import AccountSettings from './AccountSettings.svelte';
import AboutSettings from './AboutSettings.svelte';
import DevicesSettings from './DevicesSettings.svelte';
import EmoteSettings from '#lib/features/emotes/EmoteSettings.svelte';
import KeyboardSettings from './KeyboardSettings.svelte';

export interface StandaloneSection {
  id: string;
  label: string;
  icon: Component;
  component: Component;
}

interface SettingsNavGroup {
  id: string;
  label?: string;
  sections: string[];
}

export const settingsNavGroups: SettingsNavGroup[] = [
  {
    id: 'user',
    label: 'settings.navGroups.user',
    sections: [
      SETTINGS_ACCOUNT_SECTION,
      SETTINGS_EMOTES_SECTION,
      SETTINGS_DEVICES_SECTION,
      'privacy',
      'personas',
    ],
  },
  {
    id: 'interface',
    label: 'settings.navGroups.interface',
    sections: ['appearance', 'composer', 'keyboard', 'media', 'timeline', 'desktop'],
  },
  {
    id: 'behavior',
    label: 'settings.navGroups.behavior',
    sections: ['notifications', 'calls', 'developer'],
  },
  { id: 'about', sections: ['about'] },
];

const standaloneSections: StandaloneSection[] = [
  {
    id: SETTINGS_ACCOUNT_SECTION,
    label: 'settings.account',
    icon: UserCircleIcon,
    component: AccountSettings,
  },
  {
    id: SETTINGS_EMOTES_SECTION,
    label: 'settings.emotes',
    icon: SmileyIcon,
    component: EmoteSettings,
  },
  {
    id: 'keyboard',
    label: 'settings.keyboard',
    icon: KeyboardIcon,
    component: KeyboardSettings,
  },
  {
    id: SETTINGS_DEVICES_SECTION,
    label: 'settings.security',
    icon: LockKeyIcon,
    component: DevicesSettings,
  },
  {
    id: 'about',
    label: 'settings.about',
    icon: InfoIcon,
    component: AboutSettings,
  },
];

export function findStandaloneSection(id: string | null): StandaloneSection | undefined {
  if (id === null) return undefined;

  return standaloneSections.find((section) => section.id === id);
}
