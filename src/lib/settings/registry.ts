import type { TimelinePreferences } from './timeline-preferences.svelte';

export type BooleanPreference = {
  [K in keyof TimelinePreferences]: TimelinePreferences[K] extends boolean ? K : never;
}[keyof TimelinePreferences];

export interface SettingOption {
  value: string;
  label: string;
}

interface BaseSetting {
  name: string;
  description?: string;
  /** Rendered disabled until this preference is on. */
  gatedBy?: BooleanPreference;
}

export interface BooleanSetting extends BaseSetting {
  type: 'boolean';
  key: BooleanPreference;
}

export interface SelectSetting extends BaseSetting {
  type: 'select';
  key: 'layout';
  options: SettingOption[];
}

export type SettingDefinition = BooleanSetting | SelectSetting;
export type SettingType = SettingDefinition['type'];

export interface SettingsCategory {
  id: string;
  name: string;
  description?: string;
  items: SettingDefinition[];
}

export const settingsCategories: SettingsCategory[] = [
  {
    id: 'appearance',
    name: 'settings.appearanceTitle',
    description: 'settings.appearanceDescription',
    items: [
      {
        key: 'layout',
        name: 'settings.layout',
        description: 'settings.layoutHint',
        type: 'select',
        options: [
          { value: 'modern', label: 'settings.layoutModern' },
          { value: 'compact', label: 'settings.layoutCompact' },
          { value: 'bubble', label: 'settings.layoutBubble' },
        ],
      },
    ],
  },
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
        key: 'hideMemberInReadOnly',
        name: 'settings.hideMemberInReadOnly',
        description: 'settings.hideMemberInReadOnlyHint',
        type: 'boolean',
      },
      {
        key: 'showTombstoneEvents',
        name: 'settings.showTombstoneEvents',
        description: 'settings.showTombstoneEventsHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'developer',
    name: 'settings.developerTitle',
    description: 'settings.developerDescription',
    items: [
      {
        key: 'showHiddenEvents',
        name: 'settings.showHiddenEvents',
        description: 'settings.showHiddenEventsHint',
        type: 'boolean',
      },
      {
        key: 'showNonStandardEvents',
        name: 'settings.showNonStandardEvents',
        description: 'settings.showNonStandardEventsHint',
        type: 'boolean',
        gatedBy: 'showHiddenEvents',
      },
    ],
  },
];
