import type { Component } from 'svelte';
import LockKeyIcon from 'phosphor-svelte/lib/LockKeyIcon';
import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';

import { SETTINGS_ACCOUNT_SECTION, SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';

import AccountSettings from './AccountSettings.svelte';
import DevicesSettings from './DevicesSettings.svelte';

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
    id: SETTINGS_DEVICES_SECTION,
    label: 'settings.security',
    icon: LockKeyIcon,
    component: DevicesSettings,
  },
];

export function findStandaloneSection(id: string | null): StandaloneSection | undefined {
  if (id === null) return undefined;

  return [...sectionsBeforeCategories, ...sectionsAfterCategories].find(
    (section) => section.id === id
  );
}
