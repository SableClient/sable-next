import type { Component } from 'svelte';
import ArrowCircleUpIcon from 'phosphor-svelte/lib/ArrowCircleUpIcon';
import ArrowsOutLineVerticalIcon from 'phosphor-svelte/lib/ArrowsOutLineVerticalIcon';
import BellIcon from 'phosphor-svelte/lib/BellIcon';
import BugIcon from 'phosphor-svelte/lib/BugIcon';
import CalendarBlankIcon from 'phosphor-svelte/lib/CalendarBlankIcon';
import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
import ChatTextIcon from 'phosphor-svelte/lib/ChatTextIcon';
import ChatsCircleIcon from 'phosphor-svelte/lib/ChatsCircleIcon';
import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
import CircleHalfIcon from 'phosphor-svelte/lib/CircleHalfIcon';
import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
import CloudArrowUpIcon from 'phosphor-svelte/lib/CloudArrowUpIcon';
import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
import DesktopIcon from 'phosphor-svelte/lib/DesktopIcon';
import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
import FilmStripIcon from 'phosphor-svelte/lib/FilmStripIcon';
import GifIcon from 'phosphor-svelte/lib/GifIcon';
import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
import KeyReturnIcon from 'phosphor-svelte/lib/KeyReturnIcon';
import KeyboardIcon from 'phosphor-svelte/lib/KeyboardIcon';
import LayoutIcon from 'phosphor-svelte/lib/LayoutIcon';
import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon';
import LockIcon from 'phosphor-svelte/lib/LockIcon';
import MegaphoneIcon from 'phosphor-svelte/lib/MegaphoneIcon';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
import MoonIcon from 'phosphor-svelte/lib/MoonIcon';
import PaintBrushIcon from 'phosphor-svelte/lib/PaintBrushIcon';
import PaperPlaneTiltIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
import PulseIcon from 'phosphor-svelte/lib/PulseIcon';
import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
import TranslateIcon from 'phosphor-svelte/lib/TranslateIcon';
import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';
import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
import WheelchairMotionIcon from 'phosphor-svelte/lib/WheelchairMotionIcon';

import { presentsInApp } from '#lib/platform/notifications.js';
import { syncNativeTelemetryConsent } from '#lib/platform/telemetry.js';
import { supportsAutoUpdate } from '#lib/platform/updates.js';
import { supportsDesktopWindow, supportsTray } from '#lib/platform/window-decorations.js';

import { setPreference } from './preferences.svelte';
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
  /** Left out entirely where the platform has nothing for it to switch. */
  supported?: () => boolean;
  onChange?: (value: boolean) => void;
  requiresReload?: true;
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
/** Account data comes from the homeserver, not local preferences. */
export const SETTINGS_ACCOUNT_SECTION = 'account';

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
        requiresReload: true,
        onChange: (value) => {
          setPreference('telemetryAsked', true);
          syncNativeTelemetryConsent(value);
        },
      },
      {
        key: 'sessionReplay',
        icon: FilmStripIcon,
        name: 'settings.sessionReplay',
        description: 'settings.sessionReplayHint',
        type: 'boolean',
        gatedBy: 'errorReporting',
        requiresReload: true,
        onChange: () => {
          setPreference('telemetryAsked', true);
        },
      },
    ]
  : [];

const desktopCategories: SettingsCategory[] = supportsDesktopWindow()
  ? [
      {
        id: 'desktop',
        name: 'settings.desktopTitle',
        description: 'settings.desktopDescription',
        icon: DesktopIcon,
        items: [
          {
            key: 'useCustomTitleBar',
            icon: DesktopIcon,
            name: 'settings.useCustomTitleBar',
            description: 'settings.useCustomTitleBarHint',
            type: 'boolean',
          },
          ...(supportsTray()
            ? ([
                {
                  key: 'showSystemTrayIcon',
                  icon: DesktopIcon,
                  name: 'settings.showSystemTrayIcon',
                  description: 'settings.showSystemTrayIconHint',
                  type: 'boolean',
                },
                {
                  key: 'closeToTray',
                  icon: DesktopIcon,
                  name: 'settings.closeToTray',
                  description: 'settings.closeToTrayHint',
                  type: 'boolean',
                  gatedBy: 'showSystemTrayIcon',
                },
              ] satisfies SettingDefinition[])
            : []),
        ],
      },
    ]
  : [];

const updatesCategories: SettingsCategory[] = supportsAutoUpdate()
  ? [
      {
        id: 'updates',
        name: 'settings.updatesTitle',
        description: 'settings.updatesDescription',
        icon: ArrowCircleUpIcon,
        items: [
          {
            key: 'autoUpdateCheck',
            icon: ArrowCircleUpIcon,
            name: 'settings.autoUpdateCheck',
            description: 'settings.autoUpdateCheckHint',
            type: 'boolean',
          },
        ],
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
        key: 'showRoomIcon',
        icon: ImageIcon,
        name: 'settings.showRoomIcon',
        description: 'settings.showRoomIconHint',
        type: 'select',
        options: [
          { value: 'always', label: 'settings.showRoomIconAlways' },
          { value: 'collapsed', label: 'settings.showRoomIconCollapsed' },
          { value: 'never', label: 'settings.showRoomIconNever' },
        ],
      },
      {
        key: 'showRoomBanners',
        icon: ImageIcon,
        name: 'settings.showRoomBanners',
        description: 'settings.showRoomBannersHint',
        type: 'boolean',
      },
      {
        key: 'showHome',
        icon: HouseIcon,
        name: 'settings.showHome',
        description: 'settings.showHomeHint',
        type: 'boolean',
      },
      {
        key: 'showUnreadCounts',
        icon: ChatTextIcon,
        name: 'settings.showUnreadCounts',
        description: 'settings.showUnreadCountsHint',
        type: 'boolean',
      },
      {
        key: 'badgeCountDMsOnly',
        icon: ChatsCircleIcon,
        name: 'settings.badgeCountDMsOnly',
        description: 'settings.badgeCountDMsOnlyHint',
        type: 'boolean',
      },
      {
        key: 'showPingCounts',
        icon: MegaphoneIcon,
        name: 'settings.showPingCounts',
        description: 'settings.showPingCountsHint',
        type: 'boolean',
      },
      {
        key: 'uniformIcons',
        icon: SquaresFourIcon,
        name: 'settings.uniformIcons',
        description: 'settings.uniformIconsHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'accessibility',
    name: 'settings.accessibilityTitle',
    description: 'settings.accessibilityDescription',
    icon: WheelchairMotionIcon,
    items: [
      {
        key: 'fontScale',
        icon: TextAaIcon,
        name: 'settings.fontScale',
        description: 'settings.fontScaleHint',
        type: 'select',
        options: [
          { value: 'small', label: 'settings.fontScaleSmall' },
          { value: 'default', label: 'settings.fontScaleDefault' },
          { value: 'large', label: 'settings.fontScaleLarge' },
          { value: 'largest', label: 'settings.fontScaleLargest' },
        ],
      },
      {
        key: 'highContrast',
        icon: CircleHalfIcon,
        name: 'settings.highContrast',
        description: 'settings.highContrastHint',
        type: 'boolean',
      },
      {
        key: 'underlineLinks',
        icon: LinkIcon,
        name: 'settings.underlineLinks',
        description: 'settings.underlineLinksHint',
        type: 'boolean',
      },
      {
        key: 'reducedMotion',
        icon: WheelchairMotionIcon,
        name: 'settings.reducedMotion',
        description: 'settings.reducedMotionHint',
        type: 'boolean',
      },
      {
        key: 'alwaysShowAltText',
        icon: EyeIcon,
        name: 'settings.alwaysShowAltText',
        description: 'settings.alwaysShowAltTextHint',
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
        key: 'readReceiptPlacement',
        icon: ChecksIcon,
        name: 'settings.readReceiptPlacement',
        description: 'settings.readReceiptPlacementHint',
        type: 'select',
        options: [
          { value: 'message', label: 'settings.readReceiptPlacementMessage' },
          { value: 'room', label: 'settings.readReceiptPlacementRoom' },
        ],
      },
      {
        key: 'hideTypingIndicators',
        icon: DotsThreeIcon,
        name: 'settings.hideTypingIndicators',
        description: 'settings.hideTypingIndicatorsHint',
        type: 'boolean',
      },
      {
        key: 'filterPronounsByLanguage',
        icon: TranslateIcon,
        name: 'settings.filterPronounsByLanguage',
        description: 'settings.filterPronounsByLanguageHint',
        type: 'boolean',
      },
      {
        key: 'pronounPillLimit',
        icon: UserCircleIcon,
        name: 'settings.pronounPillLimit',
        description: 'settings.pronounPillLimitHint',
        type: 'select',
        options: [
          { value: '1', label: 'settings.pronounPillLimitOne' },
          { value: '2', label: 'settings.pronounPillLimitTwo' },
          { value: '3', label: 'settings.pronounPillLimitThree' },
          { value: 'all', label: 'settings.pronounPillLimitAll' },
        ],
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
        key: 'richTextComposer',
        icon: CodeIcon,
        name: 'settings.richTextComposer',
        description: 'settings.richTextComposerHint',
        type: 'boolean',
      },
      {
        key: 'formattingToolbar',
        icon: TextAaIcon,
        name: 'settings.formattingToolbar',
        description: 'settings.formattingToolbarHint',
        type: 'boolean',
        gatedBy: 'richTextComposer',
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
      },
      {
        key: 'gifProvider',
        icon: GifIcon,
        name: 'settings.gifProvider',
        description: 'settings.gifProviderHint',
        type: 'select',
        options: [
          { value: 'default', label: 'settings.gifProviderDefault' },
          { value: 'klipy', label: 'settings.gifProviderKlipy' },
          { value: 'tenor', label: 'settings.gifProviderTenor' },
          { value: 'giphy', label: 'settings.gifProviderGiphy' },
        ],
      },
      {
        key: 'urlPreviews',
        icon: LinkSimpleIcon,
        name: 'settings.urlPreviews',
        description: 'settings.urlPreviewsHint',
        type: 'boolean',
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
        supported: presentsInApp,
      },
      {
        key: 'notificationSounds',
        icon: SpeakerHighIcon,
        name: 'settings.notificationSounds',
        description: 'settings.notificationSoundsHint',
        type: 'boolean',
        gatedBy: 'desktopNotifications',
        supported: presentsInApp,
      },
      {
        key: 'notificationContent',
        icon: ChatTextIcon,
        name: 'settings.notificationContent',
        description: 'settings.notificationContentHint',
        type: 'boolean',
        gatedBy: 'desktopNotifications',
      },
      {
        key: 'notificationEncryptedContent',
        icon: LockIcon,
        name: 'settings.notificationEncryptedContent',
        description: 'settings.notificationEncryptedContentHint',
        type: 'boolean',
        gatedBy: 'notificationContent',
      },
      {
        key: 'richPushPayloads',
        icon: PaperPlaneTiltIcon,
        name: 'settings.richPushPayloads',
        description: 'settings.richPushPayloadsHint',
        type: 'boolean',
      },
      {
        key: 'clearNotificationsOnRead',
        icon: CheckCircleIcon,
        name: 'settings.clearNotificationsOnRead',
        description: 'settings.clearNotificationsOnReadHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'personas',
    name: 'personas.title',
    description: 'personas.description',
    icon: UserSwitchIcon,
    items: [
      {
        key: 'personaPicker',
        icon: UserSwitchIcon,
        name: 'personas.picker',
        description: 'personas.pickerHint',
        type: 'boolean',
      },
      {
        key: 'personaProxying',
        icon: ChatTextIcon,
        name: 'personas.proxying',
        description: 'personas.proxyingHint',
        type: 'boolean',
      },
      {
        key: 'personaLatching',
        icon: PushPinIcon,
        name: 'personas.latching',
        description: 'personas.latchingHint',
        type: 'boolean',
        gatedBy: 'personaProxying',
      },
      {
        key: 'personaFallback',
        icon: TextAaIcon,
        name: 'personas.fallback',
        description: 'personas.fallbackHint',
        type: 'boolean',
      },
    ],
  },
  ...desktopCategories,
  ...updatesCategories,
  {
    id: 'sync',
    name: 'settings.syncTitle',
    description: 'settings.syncDescription',
    icon: CloudArrowUpIcon,
    items: [
      {
        key: 'settingsSync',
        icon: CloudArrowUpIcon,
        name: 'settings.settingsSync',
        description: 'settings.settingsSyncHint',
        type: 'boolean',
      },
      {
        key: 'syncDrafts',
        icon: PencilSimpleIcon,
        name: 'settings.syncDrafts',
        description: 'settings.syncDraftsHint',
        type: 'boolean',
        gatedBy: 'settingsSync',
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
        key: 'developerTools',
        icon: CodeIcon,
        name: 'settings.developerTools',
        description: 'settings.developerToolsHint',
        type: 'boolean',
      },
      {
        key: 'showHiddenEvents',
        icon: BugIcon,
        name: 'settings.showHiddenEvents',
        description: 'settings.showHiddenEventsHint',
        type: 'boolean',
        gatedBy: 'developerTools',
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
