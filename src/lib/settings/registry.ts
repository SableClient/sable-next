import type { TimelinePreferences } from './timeline-preferences.svelte';

export type SettingType = 'boolean';

/** `name` and `description` are i18n keys. */
export interface SettingDefinition {
  key: keyof TimelinePreferences;
  name: string;
  description?: string;
  type: SettingType;
}

export interface SettingsCategory {
  id: string;
  name: string;
  description?: string;
  items: SettingDefinition[];
}

export const settingsCategories: SettingsCategory[] = [
  {
    id: 'timeline',
    name: 'settings.timelineTitle',
    description: 'settings.timelineDescription',
    items: [
      {
        key: 'hideMembershipEvents',
        name: 'settings.hideMembershipEvents',
        description: 'settings.hideMembershipEventsHint',
        type: 'boolean',
      },
      {
        key: 'hideProfileChanges',
        name: 'settings.hideProfileChanges',
        description: 'settings.hideProfileChangesHint',
        type: 'boolean',
      },
      {
        key: 'showHiddenEvents',
        name: 'settings.showHiddenEvents',
        description: 'settings.showHiddenEventsHint',
        type: 'boolean',
      },
    ],
  },
];
