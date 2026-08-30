import type { Component } from 'svelte';
import InfoIcon from 'phosphor-svelte/lib/InfoIcon';
import KeyboardIcon from 'phosphor-svelte/lib/KeyboardIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import LockKeyIcon from 'phosphor-svelte/lib/LockKeyIcon';
import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';

import { SETTINGS_ACCOUNT_SECTION, SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';

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

export const sectionsBeforeCategories: StandaloneSection[] = [
  {
    id: SETTINGS_ACCOUNT_SECTION,
    label: 'settings.account',
    icon: UserCircleIcon,
    component: AccountSettings,
  },
];

export const sectionsAfterCategories: StandaloneSection[] = [
  {
    id: 'emotes',
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

  return [...sectionsBeforeCategories, ...sectionsAfterCategories].find(
    (section) => section.id === id
  );
}
