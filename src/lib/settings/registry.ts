import type { Component } from 'svelte';
import ArrowsOutLineVerticalIcon from 'phosphor-svelte/lib/ArrowsOutLineVerticalIcon';
import BellIcon from 'phosphor-svelte/lib/BellIcon';
import BugIcon from 'phosphor-svelte/lib/BugIcon';
import CalendarBlankIcon from 'phosphor-svelte/lib/CalendarBlankIcon';
import ChatTextIcon from 'phosphor-svelte/lib/ChatTextIcon';
import ChatsCircleIcon from 'phosphor-svelte/lib/ChatsCircleIcon';
import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
import FilmStripIcon from 'phosphor-svelte/lib/FilmStripIcon';
import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
import KeyReturnIcon from 'phosphor-svelte/lib/KeyReturnIcon';
import KeyboardIcon from 'phosphor-svelte/lib/KeyboardIcon';
import LayoutIcon from 'phosphor-svelte/lib/LayoutIcon';
import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon';
import MegaphoneIcon from 'phosphor-svelte/lib/MegaphoneIcon';
import MoonIcon from 'phosphor-svelte/lib/MoonIcon';
import PaintBrushIcon from 'phosphor-svelte/lib/PaintBrushIcon';
import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
import PulseIcon from 'phosphor-svelte/lib/PulseIcon';
import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
import UsersIcon from 'phosphor-svelte/lib/UsersIcon';

import type { FreeTextPreference, Preferences } from './preferences.svelte';

export type BooleanPreference = {
  [K in keyof Preferences]: Preferences[K] extends boolean ? K : never;
}[keyof Preferences];

export type SelectPreference = Exclude<
  {
    [K in keyof Preferences]: Preferences[K] extends string ? K : never;
  }[keyof Preferences],
  FreeTextPreference
>;

export interface SettingOption {
  value: string;
  label: string;
}

interface BaseSetting {
  name: string;
  icon: Component;
  description?: string;
  /** Rendered disabled until this preference is on. */
  gatedBy?: BooleanPreference;
  /** The feature behind this setting does not exist yet; shown disabled. */
  unavailable?: true;
}

export interface BooleanSetting extends BaseSetting {
  type: 'boolean';
  key: BooleanPreference;
}

export interface SelectSetting extends BaseSetting {
  type: 'select';
  key: SelectPreference;
  options: SettingOption[];
}

export type SettingDefinition = BooleanSetting | SelectSetting;
export type SettingType = SettingDefinition['type'];

export interface SettingsCategory {
  id: string;
  name: string;
  description?: string;
  icon: Component;
  items: SettingDefinition[];
}

/** The one settings section that is not preference-driven. */
export const SETTINGS_DEVICES_SECTION = 'devices';

export function findCategory(id: string | undefined): SettingsCategory | undefined {
  return settingsCategories.find((category) => category.id === id);
}

/** Stable anchor for `/settings/<category>?focus=<id>` permalinks. */
export function settingFocusId(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function findSettingByFocusId(
  focus: string
): { category: SettingsCategory; setting: SettingDefinition } | undefined {
  for (const category of settingsCategories) {
    const setting = category.items.find((item) => settingFocusId(item.key) === focus);
    if (setting) return { category, setting };
  }
  return undefined;
}

/** A build without a DSN has no error reporting to offer, so the rows are absent. */
const telemetrySettings: SettingDefinition[] = import.meta.env.VITE_SENTRY_DSN
  ? [
      {
        key: 'errorReporting',
        icon: BugIcon,
        name: 'settings.errorReporting',
        description: 'settings.errorReportingHint',
        type: 'boolean',
      },
      {
        key: 'sessionReplay',
        icon: FilmStripIcon,
        name: 'settings.sessionReplay',
        description: 'settings.sessionReplayHint',
        type: 'boolean',
        gatedBy: 'errorReporting',
      },
    ]
  : [];

export const settingsCategories: SettingsCategory[] = [
  {
    id: 'appearance',
    name: 'settings.appearanceTitle',
    description: 'settings.appearanceDescription',
    icon: PaintBrushIcon,
    items: [
      {
        key: 'theme',
        icon: MoonIcon,
        name: 'settings.theme',
        description: 'settings.themeHint',
        type: 'select',
        unavailable: true,
        options: [
          { value: 'system', label: 'settings.themeSystem' },
          { value: 'dark', label: 'settings.themeDark' },
          { value: 'light', label: 'settings.themeLight' },
        ],
      },
      {
        key: 'layout',
        icon: LayoutIcon,
        name: 'settings.layout',
        description: 'settings.layoutHint',
        type: 'select',
        options: [
          { value: 'modern', label: 'settings.layoutModern' },
          { value: 'compact', label: 'settings.layoutCompact' },
          { value: 'bubble', label: 'settings.layoutBubble' },
        ],
      },
      {
        key: 'messageSpacing',
        icon: ArrowsOutLineVerticalIcon,
        name: 'settings.messageSpacing',
        description: 'settings.messageSpacingHint',
        type: 'select',
        options: [
          { value: 'compact', label: 'settings.spacingCompact' },
          { value: 'cozy', label: 'settings.spacingCozy' },
          { value: 'roomy', label: 'settings.spacingRoomy' },
        ],
      },
      {
        key: 'underlineLinks',
        icon: LinkIcon,
        name: 'settings.underlineLinks',
        description: 'settings.underlineLinksHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'time',
    name: 'settings.timeTitle',
    description: 'settings.timeDescription',
    icon: ClockIcon,
    items: [
      {
        key: 'hour24Clock',
        icon: ClockIcon,
        name: 'settings.hour24Clock',
        description: 'settings.hour24ClockHint',
        type: 'boolean',
      },
      {
        key: 'dateFormat',
        icon: CalendarBlankIcon,
        name: 'settings.dateFormat',
        description: 'settings.dateFormatHint',
        type: 'select',
        options: [
          { value: 'auto', label: 'settings.dateFormatAuto' },
          { value: 'dmy', label: 'settings.dateFormatDmy' },
          { value: 'mdy', label: 'settings.dateFormatMdy' },
          { value: 'ymd', label: 'settings.dateFormatYmd' },
        ],
      },
    ],
  },
  {
    id: 'timeline',
    name: 'settings.timelineTitle',
    description: 'settings.timelineDescription',
    icon: ChatsCircleIcon,
    items: [
      {
        key: 'hideMembershipEvents',
        icon: UsersIcon,
        name: 'settings.hideMembershipEvents',
        description: 'settings.hideMembershipEventsHint',
        type: 'boolean',
      },
      {
        key: 'hideProfileChanges',
        icon: UserCircleIcon,
        name: 'settings.hideProfileChanges',
        description: 'settings.hideProfileChangesHint',
        type: 'boolean',
      },
      {
        key: 'hideMemberInReadOnly',
        icon: MegaphoneIcon,
        name: 'settings.hideMemberInReadOnly',
        description: 'settings.hideMemberInReadOnlyHint',
        type: 'boolean',
      },
      {
        key: 'showTombstoneEvents',
        icon: TrashIcon,
        name: 'settings.showTombstoneEvents',
        description: 'settings.showTombstoneEventsHint',
        type: 'boolean',
      },
      {
        key: 'hideReadReceipts',
        icon: ChecksIcon,
        name: 'settings.hideReadReceipts',
        description: 'settings.hideReadReceiptsHint',
        type: 'boolean',
      },
      {
        key: 'hideTypingIndicators',
        icon: DotsThreeIcon,
        name: 'settings.hideTypingIndicators',
        description: 'settings.hideTypingIndicatorsHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'composer',
    name: 'settings.composerTitle',
    description: 'settings.composerDescription',
    icon: PencilSimpleIcon,
    items: [
      {
        key: 'enterForNewline',
        icon: KeyReturnIcon,
        name: 'settings.enterForNewline',
        description: 'settings.enterForNewlineHint',
        type: 'boolean',
      },
      {
        key: 'formattingToolbar',
        icon: TextAaIcon,
        name: 'settings.formattingToolbar',
        description: 'settings.formattingToolbarHint',
        type: 'boolean',
        unavailable: true,
      },
    ],
  },
  {
    id: 'privacy',
    name: 'settings.privacyTitle',
    description: 'settings.privacyDescription',
    icon: EyeSlashIcon,
    items: [
      {
        key: 'sendTypingNotifications',
        icon: KeyboardIcon,
        name: 'settings.sendTypingNotifications',
        description: 'settings.sendTypingNotificationsHint',
        type: 'boolean',
      },
      {
        key: 'sendReadReceipts',
        icon: EyeIcon,
        name: 'settings.sendReadReceipts',
        description: 'settings.sendReadReceiptsHint',
        type: 'boolean',
      },
      {
        key: 'sendPresence',
        icon: PulseIcon,
        name: 'settings.sendPresence',
        description: 'settings.sendPresenceHint',
        type: 'boolean',
        unavailable: true,
      },
      ...telemetrySettings,
    ],
  },
  {
    id: 'media',
    name: 'settings.mediaTitle',
    description: 'settings.mediaDescription',
    icon: ImageIcon,
    items: [
      {
        key: 'mediaAutoLoad',
        icon: ImageIcon,
        name: 'settings.mediaAutoLoad',
        description: 'settings.mediaAutoLoadHint',
        type: 'boolean',
        unavailable: true,
      },
      {
        key: 'autoplayGifs',
        icon: FilmStripIcon,
        name: 'settings.autoplayGifs',
        description: 'settings.autoplayGifsHint',
        type: 'boolean',
        unavailable: true,
      },
      {
        key: 'urlPreviews',
        icon: LinkSimpleIcon,
        name: 'settings.urlPreviews',
        description: 'settings.urlPreviewsHint',
        type: 'boolean',
        unavailable: true,
      },
    ],
  },
  {
    id: 'notifications',
    name: 'settings.notificationsTitle',
    description: 'settings.notificationsDescription',
    icon: BellIcon,
    items: [
      {
        key: 'desktopNotifications',
        icon: BellIcon,
        name: 'settings.desktopNotifications',
        description: 'settings.desktopNotificationsHint',
        type: 'boolean',
      },
      {
        key: 'notificationSounds',
        icon: SpeakerHighIcon,
        name: 'settings.notificationSounds',
        description: 'settings.notificationSoundsHint',
        type: 'boolean',
        gatedBy: 'desktopNotifications',
      },
      {
        key: 'notificationContent',
        icon: ChatTextIcon,
        name: 'settings.notificationContent',
        description: 'settings.notificationContentHint',
        type: 'boolean',
        gatedBy: 'desktopNotifications',
      },
    ],
  },
  {
    id: 'developer',
    name: 'settings.developerTitle',
    description: 'settings.developerDescription',
    icon: CodeIcon,
    items: [
      {
        key: 'showHiddenEvents',
        icon: BugIcon,
        name: 'settings.showHiddenEvents',
        description: 'settings.showHiddenEventsHint',
        type: 'boolean',
      },
      {
        key: 'showNonStandardEvents',
        icon: CodeIcon,
        name: 'settings.showNonStandardEvents',
        description: 'settings.showNonStandardEventsHint',
        type: 'boolean',
        gatedBy: 'showHiddenEvents',
      },
    ],
  },
];
