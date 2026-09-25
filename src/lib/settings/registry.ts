import type { Component } from 'svelte';
import ArrowCircleUpIcon from 'phosphor-svelte/lib/ArrowCircleUpIcon';
import ArrowsOutLineVerticalIcon from 'phosphor-svelte/lib/ArrowsOutLineVerticalIcon';
import AtIcon from 'phosphor-svelte/lib/AtIcon';
import BellIcon from 'phosphor-svelte/lib/BellIcon';
import BellSimpleIcon from 'phosphor-svelte/lib/BellSimpleIcon';
import BrowserIcon from 'phosphor-svelte/lib/BrowserIcon';
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
import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';
import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
import KeyReturnIcon from 'phosphor-svelte/lib/KeyReturnIcon';
import KeyboardIcon from 'phosphor-svelte/lib/KeyboardIcon';
import LayoutIcon from 'phosphor-svelte/lib/LayoutIcon';
import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon';
import LockIcon from 'phosphor-svelte/lib/LockIcon';
import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
import MagnifyingGlassPlusIcon from 'phosphor-svelte/lib/MagnifyingGlassPlusIcon';
import MegaphoneIcon from 'phosphor-svelte/lib/MegaphoneIcon';
import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
import MoonIcon from 'phosphor-svelte/lib/MoonIcon';
import PaintBrushIcon from 'phosphor-svelte/lib/PaintBrushIcon';
import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';
import PaperPlaneTiltIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
import PauseIcon from 'phosphor-svelte/lib/PauseIcon';
import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
import PulseIcon from 'phosphor-svelte/lib/PulseIcon';
import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
import QuotesIcon from 'phosphor-svelte/lib/QuotesIcon';
import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import StickerIcon from 'phosphor-svelte/lib/StickerIcon';
import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
import TranslateIcon from 'phosphor-svelte/lib/TranslateIcon';
import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';
import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
import WheelchairMotionIcon from 'phosphor-svelte/lib/WheelchairMotionIcon';
import YoutubeLogoIcon from 'phosphor-svelte/lib/YoutubeLogoIcon';

import { playNotificationSound } from '#lib/features/notifications/sound.js';
import { setLanguage } from '#lib/i18n.js';
import { availableLocales, localeLabel, SYSTEM_LANGUAGE } from '#lib/locales.js';
import { presentsInApp } from '#lib/platform/notifications.js';
import { syncNativeTelemetryConsent } from '#lib/platform/telemetry.js';
import { supportsAutoUpdate } from '#lib/platform/updates.js';
import { supportsDesktopWindow, supportsTray } from '#lib/platform/window-decorations.js';

import { setPreference } from './preferences.svelte';
import type { FreeTextPreference, Preferences, RangePreference } from './preferences.svelte';

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
  literal?: true;
}

interface BaseSetting {
  name: string;
  icon: Component;
  description?: string;
  section: string;
  /** Rendered disabled until this preference is on. */
  gatedBy?: BooleanPreference;
  /** The feature behind this setting does not exist yet; shown disabled. */
  unavailable?: true;
  /** Left out entirely where the platform has nothing for it to switch. */
  supported?: () => boolean;
  requiresReload?: true;
}

export interface BooleanSetting extends BaseSetting {
  type: 'boolean';
  key: BooleanPreference;
  onChange?: (value: boolean) => void;
}

export interface SelectSetting extends BaseSetting {
  type: 'select';
  key: SelectPreference;
  options: SettingOption[];
  onChange?: (value: string) => void;
}

export interface RangeSetting extends BaseSetting {
  type: 'range';
  key: RangePreference;
  step: number;
  applyOnCommit?: true;
  onChange?: (value: number) => void;
}

export type SettingDefinition = BooleanSetting | SelectSetting | RangeSetting;
export type SettingType = SettingDefinition['type'];

export interface SettingsSectionDefinition {
  id: string;
  name: string;
}

export interface SettingsCategory {
  id: string;
  name: string;
  description?: string;
  icon: Component;
  sections: SettingsSectionDefinition[];
  items: SettingDefinition[];
}

/** The one settings section that is not preference-driven. */
export const SETTINGS_DEVICES_SECTION = 'devices';
/** Account data comes from the homeserver, not local preferences. */
export const SETTINGS_ACCOUNT_SECTION = 'account';
export const SETTINGS_EMOTES_SECTION = 'emotes';

export const STANDALONE_PAGE_NAMES: Partial<Record<string, string>> = {
  [SETTINGS_DEVICES_SECTION]: 'settings.security',
  keyboard: 'settings.keyboard',
  about: 'settings.about',
};

const MERGED_SECTIONS: Record<string, string> = {
  accessibility: 'appearance',
  sync: SETTINGS_ACCOUNT_SECTION,
  time: 'timeline',
  updates: 'desktop',
};

export function canonicalSection(id: string): string {
  return MERGED_SECTIONS[id] ?? id;
}

export function findCategory(id: string | undefined): SettingsCategory | undefined {
  return settingsCategories.find((category) => category.id === id);
}

/** Stable anchor for `/settings/<category>?focus=<id>` permalinks. */
export function settingFocusId(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function findSettingsSection(
  id: string
): { category: SettingsCategory; section: SettingsSectionDefinition } | undefined {
  for (const category of settingsCategories) {
    const section = category.sections.find((entry) => entry.id === id);
    if (section) return { category, section };
  }
  return undefined;
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
        section: 'diagnostics',
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
        section: 'diagnostics',
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

const desktopCategories: SettingsCategory[] =
  supportsDesktopWindow() || supportsAutoUpdate()
    ? [
        {
          id: 'desktop',
          name: 'settings.desktopTitle',
          description: 'settings.desktopDescription',
          icon: DesktopIcon,
          sections: [
            { id: 'window', name: 'settings.groups.window' },
            { id: 'updates', name: 'settings.updatesTitle' },
          ],
          items: [
            {
              key: 'useCustomTitleBar',
              section: 'window',
              icon: DesktopIcon,
              name: 'settings.useCustomTitleBar',
              description: 'settings.useCustomTitleBarHint',
              type: 'boolean',
              supported: supportsDesktopWindow,
            },
            {
              key: 'showSystemTrayIcon',
              section: 'window',
              icon: DesktopIcon,
              name: 'settings.showSystemTrayIcon',
              description: 'settings.showSystemTrayIconHint',
              type: 'boolean',
              supported: () => supportsDesktopWindow() && supportsTray(),
            },
            {
              key: 'closeToTray',
              section: 'window',
              icon: DesktopIcon,
              name: 'settings.closeToTray',
              description: 'settings.closeToTrayHint',
              type: 'boolean',
              gatedBy: 'showSystemTrayIcon',
              supported: () => supportsDesktopWindow() && supportsTray(),
            },
            {
              key: 'autoUpdateCheck',
              section: 'updates',
              icon: ArrowCircleUpIcon,
              name: 'settings.autoUpdateCheck',
              description: 'settings.autoUpdateCheckHint',
              type: 'boolean',
              supported: supportsAutoUpdate,
            },
          ],
        },
      ]
    : [];

export const settingsCategories: SettingsCategory[] = [
  {
    id: SETTINGS_ACCOUNT_SECTION,
    name: 'settings.account',
    icon: CloudArrowUpIcon,
    sections: [{ id: 'sync', name: 'settings.syncTitle' }],
    items: [
      {
        key: 'settingsSync',
        section: 'sync',
        icon: CloudArrowUpIcon,
        name: 'settings.settingsSync',
        description: 'settings.settingsSyncHint',
        type: 'boolean',
      },
      {
        key: 'syncDrafts',
        section: 'sync',
        icon: PencilSimpleIcon,
        name: 'settings.syncDrafts',
        description: 'settings.syncDraftsHint',
        type: 'boolean',
        gatedBy: 'settingsSync',
      },
    ],
  },
  {
    id: SETTINGS_EMOTES_SECTION,
    name: 'settings.emotes',
    icon: SmileyIcon,
    sections: [
      { id: 'emoji-images', name: 'settings.groups.emojiImages' },
      { id: 'gif-picker', name: 'settings.groups.gifPicker' },
    ],
    items: [
      {
        key: 'twitterEmoji',
        section: 'emoji-images',
        icon: SmileyIcon,
        name: 'settings.twitterEmoji',
        description: 'settings.twitterEmojiHint',
        type: 'boolean',
      },
      {
        key: 'pixelatedImages',
        section: 'emoji-images',
        icon: GridFourIcon,
        name: 'settings.pixelatedImages',
        description: 'settings.pixelatedImagesHint',
        type: 'select',
        options: [
          { value: 'always', label: 'settings.pixelatedImagesAlways' },
          { value: 'smart', label: 'settings.pixelatedImagesSmart' },
          { value: 'never', label: 'settings.pixelatedImagesNever' },
        ],
      },
      {
        key: 'gifProvider',
        section: 'gif-picker',
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
    ],
  },
  {
    id: 'appearance',
    name: 'settings.appearanceTitle',
    description: 'settings.appearanceDescription',
    icon: PaintBrushIcon,
    sections: [
      { id: 'themes', name: 'settings.groups.themes' },
      { id: 'app-language', name: 'settings.groups.language' },
      { id: 'message-layout', name: 'settings.groups.messageLayout' },
      { id: 'sidebar', name: 'settings.groups.sidebar' },
      { id: 'unread-badges', name: 'settings.groups.unreadBadges' },
      { id: 'accessibility', name: 'settings.accessibilityTitle' },
    ],
    items: [
      {
        key: 'language',
        section: 'app-language',
        icon: TranslateIcon,
        name: 'settings.language',
        description: 'settings.languageHint',
        type: 'select',
        options: [
          { value: SYSTEM_LANGUAGE, label: 'settings.languageSystem' },
          ...availableLocales.map((code) => ({
            value: code,
            label: localeLabel(code),
            literal: true as const,
          })),
        ],
        onChange: (value) => {
          void setLanguage(value);
        },
      },
      {
        key: 'theme',
        section: 'themes',
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
        section: 'message-layout',
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
        key: 'alignOwnMessages',
        section: 'message-layout',
        icon: LayoutIcon,
        name: 'settings.alignOwnMessages',
        description: 'settings.alignOwnMessagesHint',
        type: 'boolean',
      },
      {
        key: 'messageSpacing',
        section: 'message-layout',
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
        section: 'sidebar',
        icon: ImageIcon,
        name: 'settings.showRoomIcon',
        description: 'settings.showRoomIconHint',
        type: 'select',
        options: [
          { value: 'always', label: 'settings.showRoomIconAlways' },
          { value: 'sometimes', label: 'settings.showRoomIconSometimes' },
          { value: 'collapsed', label: 'settings.showRoomIconCollapsed' },
          { value: 'never', label: 'settings.showRoomIconNever' },
        ],
      },
      {
        key: 'uniformIcons',
        section: 'sidebar',
        icon: SquaresFourIcon,
        name: 'settings.uniformIcons',
        description: 'settings.uniformIconsHint',
        type: 'boolean',
      },
      {
        key: 'showRoomBanners',
        section: 'sidebar',
        icon: ImageIcon,
        name: 'settings.showRoomBanners',
        description: 'settings.showRoomBannersHint',
        type: 'boolean',
      },
      {
        key: 'showSearch',
        section: 'sidebar',
        icon: MagnifyingGlassIcon,
        name: 'settings.showSearch',
        description: 'settings.showSearchHint',
        type: 'boolean',
      },
      {
        key: 'showUnreadCounts',
        section: 'unread-badges',
        icon: ChatTextIcon,
        name: 'settings.showUnreadCounts',
        description: 'settings.showUnreadCountsHint',
        type: 'boolean',
      },
      {
        key: 'badgeCountDMsOnly',
        section: 'unread-badges',
        icon: ChatsCircleIcon,
        name: 'settings.badgeCountDMsOnly',
        description: 'settings.badgeCountDMsOnlyHint',
        type: 'boolean',
      },
      {
        key: 'showPingCounts',
        section: 'unread-badges',
        icon: MegaphoneIcon,
        name: 'settings.showPingCounts',
        description: 'settings.showPingCountsHint',
        type: 'boolean',
      },
      {
        key: 'pageZoom',
        section: 'accessibility',
        icon: MagnifyingGlassPlusIcon,
        name: 'settings.pageZoom',
        description: 'settings.pageZoomHint',
        type: 'range',
        step: 0.05,
        applyOnCommit: true,
      },
      {
        key: 'textScale',
        section: 'accessibility',
        icon: TextAaIcon,
        name: 'settings.fontScale',
        description: 'settings.fontScaleHint',
        type: 'range',
        step: 0.05,
        applyOnCommit: true,
      },
      {
        key: 'highContrast',
        section: 'accessibility',
        icon: CircleHalfIcon,
        name: 'settings.highContrast',
        description: 'settings.highContrastHint',
        type: 'boolean',
      },
      {
        key: 'underlineLinks',
        section: 'accessibility',
        icon: LinkIcon,
        name: 'settings.underlineLinks',
        description: 'settings.underlineLinksHint',
        type: 'boolean',
      },
      {
        key: 'reducedMotion',
        section: 'accessibility',
        icon: WheelchairMotionIcon,
        name: 'settings.reducedMotion',
        description: 'settings.reducedMotionHint',
        type: 'boolean',
      },
      {
        key: 'alwaysShowAltText',
        section: 'accessibility',
        icon: EyeIcon,
        name: 'settings.alwaysShowAltText',
        description: 'settings.alwaysShowAltTextHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'timeline',
    name: 'settings.timelineTitle',
    description: 'settings.timelineDescription',
    icon: ChatsCircleIcon,
    sections: [
      { id: 'messages', name: 'settings.groups.messages' },
      { id: 'time-date', name: 'settings.timeTitle' },
      { id: 'room-events', name: 'settings.groups.roomEvents' },
      { id: 'receipts-typing', name: 'settings.groups.receiptsTyping' },
      { id: 'members-pronouns', name: 'settings.groups.membersPronouns' },
    ],
    items: [
      {
        key: 'timelineEmoteSize',
        section: 'messages',
        icon: SmileyIcon,
        name: 'settings.timelineEmoteSize',
        description: 'settings.timelineEmoteSizeHint',
        type: 'select',
        options: [
          { value: 'default', label: 'settings.timelineEmoteSizeDefault' },
          { value: '20', label: '20 px', literal: true },
          { value: '24', label: '24 px', literal: true },
          { value: '32', label: '32 px', literal: true },
          { value: '48', label: '48 px', literal: true },
          { value: '64', label: '64 px', literal: true },
        ],
      },
      {
        key: 'replyPreviewStyle',
        section: 'messages',
        icon: QuotesIcon,
        name: 'settings.replyPreviewStyle',
        description: 'settings.replyPreviewStyleHint',
        type: 'select',
        options: [
          { value: 'connected', label: 'settings.replyPreviewStyleConnected' },
          { value: 'compact', label: 'settings.replyPreviewStyleCompact' },
          { value: 'expanded', label: 'settings.replyPreviewStyleExpanded' },
        ],
      },
      {
        key: 'hour24Clock',
        section: 'time-date',
        icon: ClockIcon,
        name: 'settings.hour24Clock',
        description: 'settings.hour24ClockHint',
        type: 'boolean',
      },
      {
        key: 'dateFormat',
        section: 'time-date',
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
      {
        key: 'hideMembershipEvents',
        section: 'room-events',
        icon: UsersIcon,
        name: 'settings.hideMembershipEvents',
        description: 'settings.hideMembershipEventsHint',
        type: 'boolean',
      },
      {
        key: 'hideProfileChanges',
        section: 'room-events',
        icon: UserCircleIcon,
        name: 'settings.hideProfileChanges',
        description: 'settings.hideProfileChangesHint',
        type: 'boolean',
      },
      {
        key: 'hideMemberInReadOnly',
        section: 'room-events',
        icon: MegaphoneIcon,
        name: 'settings.hideMemberInReadOnly',
        description: 'settings.hideMemberInReadOnlyHint',
        type: 'boolean',
      },
      {
        key: 'showTombstoneEvents',
        section: 'room-events',
        icon: TrashIcon,
        name: 'settings.showTombstoneEvents',
        description: 'settings.showTombstoneEventsHint',
        type: 'boolean',
      },
      {
        key: 'hideReadReceipts',
        section: 'receipts-typing',
        icon: ChecksIcon,
        name: 'settings.hideReadReceipts',
        description: 'settings.hideReadReceiptsHint',
        type: 'boolean',
      },
      {
        key: 'readReceiptPlacement',
        section: 'receipts-typing',
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
        section: 'receipts-typing',
        icon: DotsThreeIcon,
        name: 'settings.hideTypingIndicators',
        description: 'settings.hideTypingIndicatorsHint',
        type: 'boolean',
      },
      {
        key: 'groupMembersByPresence',
        section: 'members-pronouns',
        icon: UsersIcon,
        name: 'settings.groupMembersByPresence',
        description: 'settings.groupMembersByPresenceHint',
        type: 'boolean',
      },
      {
        key: 'showPronouns',
        section: 'members-pronouns',
        icon: UserCircleIcon,
        name: 'settings.showPronouns',
        description: 'settings.showPronounsHint',
        type: 'boolean',
      },
      {
        key: 'filterPronounsByLanguage',
        section: 'members-pronouns',
        icon: TranslateIcon,
        name: 'settings.filterPronounsByLanguage',
        description: 'settings.filterPronounsByLanguageHint',
        type: 'boolean',
        gatedBy: 'showPronouns',
      },
      {
        key: 'pronounPillLimit',
        section: 'members-pronouns',
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
        gatedBy: 'showPronouns',
      },
      {
        key: 'pronounPillLength',
        section: 'members-pronouns',
        icon: TextAaIcon,
        name: 'settings.pronounPillLength',
        description: 'settings.pronounPillLengthHint',
        type: 'select',
        gatedBy: 'showPronouns',
        options: [
          { value: '12', label: '12' },
          { value: '16', label: '16' },
          { value: '24', label: '24' },
          { value: 'all', label: 'settings.pronounPillLengthAll' },
        ],
      },
    ],
  },
  {
    id: 'composer',
    name: 'settings.composerTitle',
    description: 'settings.composerDescription',
    icon: PencilSimpleIcon,
    sections: [
      { id: 'writing', name: 'settings.groups.writing' },
      { id: 'sending', name: 'settings.groups.sending' },
      { id: 'composer-buttons', name: 'settings.groups.buttons' },
      { id: 'composer-button-order', name: 'settings.composerButtonOrder' },
    ],
    items: [
      {
        key: 'enterForNewline',
        section: 'writing',
        icon: KeyReturnIcon,
        name: 'settings.enterForNewline',
        description: 'settings.enterForNewlineHint',
        type: 'boolean',
      },
      {
        key: 'richTextComposer',
        section: 'writing',
        icon: CodeIcon,
        name: 'settings.richTextComposer',
        description: 'settings.richTextComposerHint',
        type: 'boolean',
      },
      {
        key: 'formattingToolbar',
        section: 'writing',
        icon: TextAaIcon,
        name: 'settings.formattingToolbar',
        description: 'settings.formattingToolbarHint',
        type: 'boolean',
      },
      {
        key: 'mentionInReplies',
        section: 'sending',
        icon: BellIcon,
        name: 'settings.mentionInReplies',
        description: 'settings.mentionInRepliesHint',
        type: 'boolean',
      },
      {
        key: 'scheduleInEncryptedRooms',
        section: 'sending',
        icon: LockIcon,
        name: 'settings.scheduleInEncryptedRooms',
        description: 'settings.scheduleInEncryptedRoomsHint',
        type: 'boolean',
      },
      {
        key: 'composerFormatButton',
        section: 'composer-buttons',
        icon: TextAaIcon,
        name: 'settings.composerFormatButton',
        description: 'settings.composerFormatButtonHint',
        type: 'boolean',
      },
      {
        key: 'composerGifButton',
        section: 'composer-buttons',
        icon: GifIcon,
        name: 'settings.composerGifButton',
        description: 'settings.composerGifButtonHint',
        type: 'boolean',
      },
      {
        key: 'composerStickerButton',
        section: 'composer-buttons',
        icon: StickerIcon,
        name: 'settings.composerStickerButton',
        description: 'settings.composerStickerButtonHint',
        type: 'boolean',
      },
      {
        key: 'composerEmoteButton',
        section: 'composer-buttons',
        icon: SmileyIcon,
        name: 'settings.composerEmoteButton',
        description: 'settings.composerEmoteButtonHint',
        type: 'boolean',
      },
      {
        key: 'composerVoiceButton',
        section: 'composer-buttons',
        icon: MicrophoneIcon,
        name: 'settings.composerVoiceButton',
        description: 'settings.composerVoiceButtonHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'privacy',
    name: 'settings.privacyTitle',
    description: 'settings.privacyDescription',
    icon: EyeSlashIcon,
    sections: [
      { id: 'activity', name: 'settings.groups.activity' },
      { id: 'blurring', name: 'settings.groups.blurring' },
      { id: 'diagnostics', name: 'settings.groups.diagnostics' },
    ],
    items: [
      {
        key: 'sendTypingNotifications',
        section: 'activity',
        icon: KeyboardIcon,
        name: 'settings.sendTypingNotifications',
        description: 'settings.sendTypingNotificationsHint',
        type: 'boolean',
      },
      {
        key: 'sendReadReceipts',
        section: 'activity',
        icon: EyeIcon,
        name: 'settings.sendReadReceipts',
        description: 'settings.sendReadReceiptsHint',
        type: 'boolean',
      },
      {
        key: 'sendPresence',
        section: 'activity',
        icon: PulseIcon,
        name: 'settings.sendPresence',
        description: 'settings.sendPresenceHint',
        type: 'boolean',
      },
      {
        key: 'blurMedia',
        section: 'blurring',
        icon: ImageIcon,
        name: 'settings.blurMedia',
        description: 'settings.blurMediaHint',
        type: 'boolean',
      },
      {
        key: 'blurAvatars',
        section: 'blurring',
        icon: UserCircleIcon,
        name: 'settings.blurAvatars',
        description: 'settings.blurAvatarsHint',
        type: 'boolean',
      },
      {
        key: 'blurEmotes',
        section: 'blurring',
        icon: SmileyIcon,
        name: 'settings.blurEmotes',
        description: 'settings.blurEmotesHint',
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
    sections: [
      { id: 'playback', name: 'settings.groups.playback' },
      { id: 'previews', name: 'settings.groups.previews' },
      { id: 'embeds', name: 'settings.groups.embeds' },
    ],
    items: [
      {
        key: 'mediaAutoLoad',
        section: 'playback',
        icon: ImageIcon,
        name: 'settings.mediaAutoLoad',
        description: 'settings.mediaAutoLoadHint',
        type: 'boolean',
        unavailable: true,
      },
      {
        key: 'autoplayGifs',
        section: 'playback',
        icon: FilmStripIcon,
        name: 'settings.autoplayGifs',
        description: 'settings.autoplayGifsHint',
        type: 'boolean',
      },
      {
        key: 'autoplayStickers',
        section: 'playback',
        icon: StickerIcon,
        name: 'settings.autoplayStickers',
        description: 'settings.autoplayStickersHint',
        type: 'boolean',
      },
      {
        key: 'pauseAnimationsWhenInactive',
        section: 'playback',
        icon: PauseIcon,
        name: 'settings.pauseAnimationsWhenInactive',
        description: 'settings.pauseAnimationsWhenInactiveHint',
        type: 'boolean',
      },
      {
        key: 'urlPreviews',
        section: 'previews',
        icon: LinkSimpleIcon,
        name: 'settings.urlPreviews',
        description: 'settings.urlPreviewsHint',
        type: 'boolean',
      },
      {
        key: 'encryptedUrlPreviews',
        section: 'previews',
        icon: LinkSimpleIcon,
        name: 'settings.encryptedUrlPreviews',
        description: 'settings.encryptedUrlPreviewsHint',
        type: 'boolean',
      },
      {
        key: 'themeFileCards',
        section: 'previews',
        icon: PaletteIcon,
        name: 'settings.themeFileCards',
        description: 'settings.themeFileCardsHint',
        type: 'boolean',
      },
      {
        key: 'clientEmbeds',
        section: 'embeds',
        icon: BrowserIcon,
        name: 'settings.clientEmbeds',
        description: 'settings.clientEmbedsHint',
        type: 'boolean',
      },
      {
        key: 'encryptedClientEmbeds',
        section: 'embeds',
        icon: BrowserIcon,
        name: 'settings.encryptedClientEmbeds',
        description: 'settings.encryptedClientEmbedsHint',
        type: 'boolean',
        gatedBy: 'clientEmbeds',
      },
      {
        key: 'youtubeEmbeds',
        section: 'embeds',
        icon: YoutubeLogoIcon,
        name: 'settings.youtubeEmbeds',
        description: 'settings.youtubeEmbedsHint',
        type: 'boolean',
        gatedBy: 'clientEmbeds',
      },
    ],
  },
  {
    id: 'notifications',
    name: 'settings.notificationsTitle',
    description: 'settings.notificationsDescription',
    icon: BellIcon,
    sections: [
      { id: 'alerts', name: 'settings.groups.systemNotifications' },
      { id: 'sounds', name: 'settings.groups.sounds' },
      { id: 'highlights', name: 'settings.groups.highlights' },
    ],
    items: [
      {
        key: 'systemNotifications',
        section: 'alerts',
        icon: BellIcon,
        name: 'settings.systemNotifications',
        description: 'settings.systemNotificationsHint',
        type: 'boolean',
      },
      {
        key: 'notificationContent',
        section: 'alerts',
        icon: ChatTextIcon,
        name: 'settings.notificationContent',
        description: 'settings.notificationContentHint',
        type: 'boolean',
        gatedBy: 'systemNotifications',
      },
      {
        key: 'notificationEncryptedContent',
        section: 'alerts',
        icon: LockIcon,
        name: 'settings.notificationEncryptedContent',
        description: 'settings.notificationEncryptedContentHint',
        type: 'boolean',
        gatedBy: 'notificationContent',
      },
      {
        key: 'notifyOnce',
        section: 'alerts',
        icon: BellSimpleIcon,
        name: 'settings.notifyOnce',
        description: 'settings.notifyOnceHint',
        type: 'boolean',
      },
      {
        key: 'clearNotificationsOnRead',
        section: 'alerts',
        icon: CheckCircleIcon,
        name: 'settings.clearNotificationsOnRead',
        description: 'settings.clearNotificationsOnReadHint',
        type: 'boolean',
      },
      {
        key: 'richPushPayloads',
        section: 'alerts',
        icon: PaperPlaneTiltIcon,
        name: 'settings.richPushPayloads',
        description: 'settings.richPushPayloadsHint',
        type: 'boolean',
      },
      {
        key: 'notificationSounds',
        section: 'sounds',
        icon: SpeakerHighIcon,
        name: 'settings.notificationSounds',
        description: 'settings.notificationSoundsHint',
        type: 'boolean',
      },
      {
        key: 'notificationSoundVolume',
        section: 'sounds',
        icon: SpeakerHighIcon,
        name: 'settings.notificationSoundVolume',
        description: 'settings.notificationSoundVolumeHint',
        type: 'range',
        gatedBy: 'notificationSounds',
        step: 0.05,
        onChange: () => {
          void playNotificationSound().catch(() => undefined);
        },
      },
      {
        key: 'backgroundNotificationSounds',
        section: 'sounds',
        icon: SpeakerHighIcon,
        name: 'settings.backgroundNotificationSounds',
        description: 'settings.backgroundNotificationSoundsHint',
        type: 'boolean',
        gatedBy: 'notificationSounds',
        supported: presentsInApp,
      },
      {
        key: 'highlightMentions',
        section: 'highlights',
        icon: AtIcon,
        name: 'settings.highlightMentions',
        description: 'settings.highlightMentionsHint',
        type: 'boolean',
      },
      {
        key: 'faviconForMentionsOnly',
        section: 'highlights',
        icon: AtIcon,
        name: 'settings.faviconForMentionsOnly',
        description: 'settings.faviconForMentionsOnlyHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'calls',
    name: 'settings.callsTitle',
    description: 'settings.callsDescription',
    icon: PhoneIcon,
    sections: [
      { id: 'call-devices', name: 'settings.callDevicesTitle' },
      { id: 'microphone', name: 'settings.groups.microphone' },
      { id: 'ringing', name: 'settings.groups.ringing' },
      { id: 'call-button', name: 'settings.groups.callButton' },
    ],
    items: [
      {
        key: 'noiseSuppression',
        section: 'microphone',
        icon: MicrophoneIcon,
        name: 'settings.noiseSuppression',
        description: 'settings.noiseSuppressionHint',
        type: 'boolean',
      },
      {
        key: 'voiceIsolation',
        section: 'microphone',
        icon: MicrophoneIcon,
        name: 'settings.voiceIsolation',
        description: 'settings.voiceIsolationHint',
        type: 'boolean',
        gatedBy: 'noiseSuppression',
      },
      {
        key: 'echoCancellation',
        section: 'microphone',
        icon: MicrophoneIcon,
        name: 'settings.echoCancellation',
        description: 'settings.echoCancellationHint',
        type: 'boolean',
      },
      {
        key: 'autoGainControl',
        section: 'microphone',
        icon: MicrophoneIcon,
        name: 'settings.autoGainControl',
        description: 'settings.autoGainControlHint',
        type: 'boolean',
      },
      {
        key: 'incomingCallSound',
        section: 'ringing',
        icon: PhoneIcon,
        name: 'settings.incomingCallSound',
        description: 'settings.incomingCallSoundHint',
        type: 'boolean',
      },
      {
        key: 'callRingtoneVolume',
        section: 'ringing',
        icon: SpeakerHighIcon,
        name: 'settings.callRingtoneVolume',
        description: 'settings.callRingtoneVolumeHint',
        type: 'select',
        gatedBy: 'incomingCallSound',
        options: [
          { value: 'quiet', label: 'settings.callRingtoneVolumeQuiet' },
          { value: 'normal', label: 'settings.callRingtoneVolumeNormal' },
          { value: 'loud', label: 'settings.callRingtoneVolumeLoud' },
        ],
      },
      {
        key: 'outgoingRingback',
        section: 'ringing',
        icon: PhoneIcon,
        name: 'settings.outgoingRingback',
        description: 'settings.outgoingRingbackHint',
        type: 'boolean',
      },
      {
        key: 'ringForGroupCalls',
        section: 'ringing',
        icon: PhoneIcon,
        name: 'settings.ringForGroupCalls',
        description: 'settings.ringForGroupCallsHint',
        type: 'boolean',
      },
      {
        key: 'alwaysShowCallButton',
        section: 'call-button',
        icon: PhoneIcon,
        name: 'settings.alwaysShowCallButton',
        description: 'settings.alwaysShowCallButtonHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'personas',
    name: 'personas.title',
    description: 'personas.description',
    icon: UserSwitchIcon,
    sections: [{ id: 'persona-sending', name: 'settings.groups.sending' }],
    items: [
      {
        key: 'personaPicker',
        section: 'persona-sending',
        icon: UserSwitchIcon,
        name: 'personas.picker',
        description: 'personas.pickerHint',
        type: 'boolean',
      },
      {
        key: 'personaProxying',
        section: 'persona-sending',
        icon: ChatTextIcon,
        name: 'personas.proxying',
        description: 'personas.proxyingHint',
        type: 'boolean',
      },
      {
        key: 'personaLatching',
        section: 'persona-sending',
        icon: PushPinIcon,
        name: 'personas.latching',
        description: 'personas.latchingHint',
        type: 'select',
        options: [
          { value: 'off', label: 'personas.scopeLatchOff' },
          { value: 'room', label: 'personas.scopeLatchRoom' },
          { value: 'account', label: 'personas.scopeLatchAccount' },
        ],
        gatedBy: 'personaProxying',
      },
      {
        key: 'personaFallback',
        section: 'persona-sending',
        icon: TextAaIcon,
        name: 'personas.fallback',
        description: 'personas.fallbackHint',
        type: 'boolean',
      },
    ],
  },
  ...desktopCategories,
  {
    id: 'developer',
    name: 'settings.developerTitle',
    description: 'settings.developerDescription',
    icon: CodeIcon,
    sections: [
      { id: 'developer-options', name: 'settings.groups.developerTools' },
      { id: 'developer-sync-diagnostics', name: 'settings.developerSyncTitle' },
      { id: 'developer-search-metrics', name: 'settings.developerSearchTitle' },
      { id: 'developer-account-data', name: 'settings.developerAccountDataTitle' },
      { id: 'developer-notifications', name: 'settings.developerNotificationsTitle' },
      { id: 'developer-debug-logs', name: 'settings.developerLogsTitle' },
      { id: 'developer-sentry', name: 'settings.developerSentryTitle' },
      { id: 'settings-state-event', name: 'settings.stateEventTitle' },
    ],
    items: [
      {
        key: 'developerTools',
        section: 'developer-options',
        icon: CodeIcon,
        name: 'settings.developerTools',
        description: 'settings.developerToolsHint',
        type: 'boolean',
      },
      {
        key: 'showHiddenEvents',
        section: 'developer-options',
        icon: BugIcon,
        name: 'settings.showHiddenEvents',
        description: 'settings.showHiddenEventsHint',
        type: 'boolean',
        gatedBy: 'developerTools',
      },
      {
        key: 'hiddenEventEdits',
        section: 'developer-options',
        icon: PencilSimpleIcon,
        name: 'settings.hiddenEventEdits',
        description: 'settings.hiddenEventEditsHint',
        type: 'boolean',
        gatedBy: 'showHiddenEvents',
      },
      {
        key: 'hiddenEventReactions',
        section: 'developer-options',
        icon: SmileyIcon,
        name: 'settings.hiddenEventReactions',
        description: 'settings.hiddenEventReactionsHint',
        type: 'boolean',
        gatedBy: 'showHiddenEvents',
      },
      {
        key: 'hiddenEventRedactions',
        section: 'developer-options',
        icon: TrashIcon,
        name: 'settings.hiddenEventRedactions',
        description: 'settings.hiddenEventRedactionsHint',
        type: 'boolean',
        gatedBy: 'showHiddenEvents',
      },
      {
        key: 'hiddenEventOther',
        section: 'developer-options',
        icon: DotsThreeIcon,
        name: 'settings.hiddenEventOther',
        description: 'settings.hiddenEventOtherHint',
        type: 'boolean',
        gatedBy: 'showHiddenEvents',
      },
    ],
  },
];
