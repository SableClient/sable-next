import type { Component } from 'svelte';
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
import DotIcon from 'phosphor-svelte/lib/DotIcon';
import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
import FilmStripIcon from 'phosphor-svelte/lib/FilmStripIcon';
import GifIcon from 'phosphor-svelte/lib/GifIcon';
import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';
import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
import KeyReturnIcon from 'phosphor-svelte/lib/KeyReturnIcon';
import KeyboardIcon from 'phosphor-svelte/lib/KeyboardIcon';
import LayoutIcon from 'phosphor-svelte/lib/LayoutIcon';
import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon';
import LockIcon from 'phosphor-svelte/lib/LockIcon';
import DatabaseIcon from 'phosphor-svelte/lib/DatabaseIcon';
import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
import MagnifyingGlassPlusIcon from 'phosphor-svelte/lib/MagnifyingGlassPlusIcon';
import MegaphoneIcon from 'phosphor-svelte/lib/MegaphoneIcon';
import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
import MonitorIcon from 'phosphor-svelte/lib/MonitorIcon';
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
import SubtitlesIcon from 'phosphor-svelte/lib/SubtitlesIcon';
import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
import TextAlignLeftIcon from 'phosphor-svelte/lib/TextAlignLeftIcon';
import TranslateIcon from 'phosphor-svelte/lib/TranslateIcon';
import TreeStructureIcon from 'phosphor-svelte/lib/TreeStructureIcon';
import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';
import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
import WheelchairMotionIcon from 'phosphor-svelte/lib/WheelchairMotionIcon';
import TiktokLogoIcon from 'phosphor-svelte/lib/TiktokLogoIcon';
import YoutubeLogoIcon from 'phosphor-svelte/lib/YoutubeLogoIcon';

import { playNotificationSound } from '#lib/features/notifications/sound.js';
import { currentLocale, setLanguage } from '#lib/i18n.js';
import { availableLocales, localeLabel, SYSTEM_LANGUAGE } from '#lib/locales.js';
import { hasNativeCalls } from '#lib/platform/calls.js';
import { presentsInApp } from '#lib/platform/notifications.js';
import { isNativeMobile } from '#lib/platform/os.js';
import { syncTelemetryConsent } from '#lib/platform/telemetry.js';
import { supportsDesktopWindow, supportsTray } from '#lib/platform/window-decorations.js';

import {
  CALL_VIDEO_BITRATES,
  CALL_VIDEO_CODECS,
  CALL_VIDEO_RESOLUTIONS,
  SEARCH_BASE_EVENTS,
  SEARCH_BATCH_SIZES,
  SEARCH_CRAWL_PAUSES,
  SEARCH_FLUSH_INTERVALS,
  SEARCH_INDEX_LIMITS,
  SEARCH_MAX_EVENTS,
  SEARCH_TRICKLE_PAUSES,
  setPreference,
  SUBSPACE_DEPTHS,
} from './preferences.svelte';
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

const callResolutionOptions: SettingOption[] = CALL_VIDEO_RESOLUTIONS.map((value) =>
  value === 'auto'
    ? { value, label: 'settings.callVideoAutomatic' }
    : { value, label: `${value}p`, literal: true }
);
const callBitrateOptions: SettingOption[] = CALL_VIDEO_BITRATES.map((value) =>
  value === 'auto'
    ? { value, label: 'settings.callVideoAutomatic' }
    : { value, label: `${value} kbps`, literal: true }
);
const callCodecOptions: SettingOption[] = CALL_VIDEO_CODECS.map((value) =>
  value === 'auto'
    ? { value, label: 'settings.callVideoAutomatic' }
    : { value, label: value === 'h264' ? 'H.264' : value.toUpperCase(), literal: true }
);

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
  updates: 'about',
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
          syncTelemetryConsent(value);
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

const desktopCategories: SettingsCategory[] = supportsDesktopWindow()
  ? [
      {
        id: 'desktop',
        name: 'settings.desktopTitle',
        icon: DesktopIcon,
        sections: [{ id: 'window', name: 'settings.groups.window' }],
        items: [
          {
            key: 'useCustomTitleBar',
            section: 'window',
            icon: DesktopIcon,
            name: 'settings.useCustomTitleBar',
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
        ],
      },
    ]
  : [];

export const settingsCategories: SettingsCategory[] = [
  {
    id: SETTINGS_ACCOUNT_SECTION,
    name: 'settings.account',
    icon: CloudArrowUpIcon,
    sections: [
      { id: 'profile-changes', name: 'settings.profileChangesTitle' },
      { id: 'sync', name: 'settings.syncTitle' },
    ],
    items: [
      {
        key: 'profileChangePropagation',
        section: 'profile-changes',
        icon: UsersIcon,
        name: 'settings.profileChangePropagation',
        description: 'settings.profileChangePropagationHint',
        type: 'select',
        options: [
          { value: 'all', label: 'settings.profileChangePropagationAll' },
          { value: 'unchanged', label: 'settings.profileChangePropagationUnchanged' },
          { value: 'none', label: 'settings.profileChangePropagationNone' },
        ],
      },
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
        key: 'threadPresentation',
        section: 'message-layout',
        icon: LayoutIcon,
        name: 'settings.threadPresentation',
        description: 'settings.threadPresentationHint',
        type: 'select',
        options: [
          { value: 'timeline', label: 'settings.threadPresentationTimeline' },
          { value: 'panel', label: 'settings.threadPresentationPanel' },
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
        type: 'select',
        options: [
          { value: 'always', label: 'settings.showRoomIconAlways' },
          { value: 'sometimes', label: 'settings.showRoomIconSometimes' },
          { value: 'collapsed', label: 'settings.showRoomIconCollapsed' },
          { value: 'never', label: 'settings.showRoomIconNever' },
        ],
      },
      {
        key: 'showSpaceEvents',
        section: 'sidebar',
        icon: CalendarBlankIcon,
        name: 'settings.showSpaceEvents',
        description: 'settings.showSpaceEventsHint',
        type: 'boolean',
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
        type: 'boolean',
      },
      {
        key: 'subspaceHierarchyLimit',
        section: 'sidebar',
        icon: TreeStructureIcon,
        name: 'settings.subspaceHierarchyLimit',
        description: 'settings.subspaceHierarchyLimitHint',
        type: 'select',
        options: SUBSPACE_DEPTHS.map((depth) => ({ value: depth, label: depth, literal: true })),
      },
      {
        key: 'showHome',
        section: 'sidebar',
        icon: HouseIcon,
        name: 'settings.showHome',
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
        key: 'showUnreadDots',
        section: 'unread-badges',
        icon: DotIcon,
        name: 'settings.showUnreadDots',
        description: 'settings.showUnreadDotsHint',
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
        key: 'nameColorCorrection',
        section: 'accessibility',
        icon: PaletteIcon,
        name: 'settings.nameColorCorrection',
        description: 'settings.nameColorCorrectionHint',
        type: 'select',
        options: [
          { value: 'strong', label: 'settings.nameColorCorrectionStrong' },
          { value: 'weak', label: 'settings.nameColorCorrectionWeak' },
          { value: 'off', label: 'settings.nameColorCorrectionOff' },
        ],
      },
      {
        key: 'renderRoomColors',
        section: 'accessibility',
        icon: PaletteIcon,
        name: 'settings.renderRoomColors',
        description: 'settings.renderRoomColorsHint',
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
    icon: ChatsCircleIcon,
    sections: [
      { id: 'messages', name: 'settings.groups.messages' },
      { id: 'time-date', name: 'settings.timeTitle' },
      { id: 'room-events', name: 'settings.groups.roomEvents' },
      { id: 'receipts-typing', name: 'settings.groups.receiptsTyping' },
      { id: 'members-pronouns', name: 'settings.groups.membersPronouns' },
      { id: 'message-search', name: 'settings.groups.messageSearch' },
      { id: 'developer-search-metrics', name: 'settings.developerSearchTitle' },
    ],
    items: [
      {
        key: 'showSearch',
        section: 'message-search',
        icon: MagnifyingGlassIcon,
        name: 'settings.showSearch',
        type: 'boolean',
      },
      {
        key: 'searchCrawler',
        section: 'message-search',
        icon: DatabaseIcon,
        name: 'settings.searchCrawler',
        description: 'settings.searchCrawlerHint',
        type: 'boolean',
      },
      {
        key: 'searchUnmeteredOnly',
        section: 'message-search',
        icon: DatabaseIcon,
        name: 'settings.searchUnmeteredOnly',
        description: 'settings.searchUnmeteredOnlyHint',
        type: 'boolean',
        gatedBy: 'searchCrawler',
        supported: isNativeMobile,
      },
      {
        key: 'serverSearch',
        section: 'message-search',
        icon: MagnifyingGlassIcon,
        name: 'settings.serverSearch',
        description: 'settings.serverSearchHint',
        type: 'boolean',
      },
      {
        key: 'searchIndexLimit',
        section: 'message-search',
        icon: DatabaseIcon,
        name: 'settings.searchIndexLimit',
        description: 'settings.searchIndexLimitHint',
        type: 'select',
        options: SEARCH_INDEX_LIMITS.map((limit) => ({
          value: limit,
          label: Number(limit) >= 1024 ? `${String(Number(limit) / 1024)} GB` : `${limit} MB`,
          literal: true,
        })),
      },
      {
        key: 'searchCrawlPause',
        section: 'developer-search-metrics',
        icon: DatabaseIcon,
        name: 'settings.searchCrawlPause',
        description: 'settings.searchCrawlPauseHint',
        type: 'select',
        gatedBy: 'developerTools',
        options: SEARCH_CRAWL_PAUSES.map((value) => ({
          value,
          label: `${value} s`,
          literal: true,
        })),
      },
      {
        key: 'searchTricklePause',
        section: 'developer-search-metrics',
        icon: DatabaseIcon,
        name: 'settings.searchTricklePause',
        description: 'settings.searchTricklePauseHint',
        type: 'select',
        gatedBy: 'developerTools',
        options: SEARCH_TRICKLE_PAUSES.map((value) => ({
          value,
          label: `${value} s`,
          literal: true,
        })),
      },
      {
        key: 'searchFlushInterval',
        section: 'developer-search-metrics',
        icon: DatabaseIcon,
        name: 'settings.searchFlushInterval',
        description: 'settings.searchFlushIntervalHint',
        type: 'select',
        gatedBy: 'developerTools',
        options: SEARCH_FLUSH_INTERVALS.map((value) => ({
          value,
          label: `${value} s`,
          literal: true,
        })),
      },
      {
        key: 'searchBatchSize',
        section: 'developer-search-metrics',
        icon: DatabaseIcon,
        name: 'settings.searchBatchSize',
        type: 'select',
        gatedBy: 'developerTools',
        options: SEARCH_BATCH_SIZES.map((value) => ({
          value,
          get label() {
            return `${Number(value).toLocaleString(currentLocale())} events`;
          },
          literal: true,
        })),
      },
      {
        key: 'searchBaseEvents',
        section: 'developer-search-metrics',
        icon: DatabaseIcon,
        name: 'settings.searchBaseEvents',
        description: 'settings.searchBaseEventsHint',
        type: 'select',
        gatedBy: 'developerTools',
        options: SEARCH_BASE_EVENTS.map((value) => ({
          value,
          get label() {
            return `${Number(value).toLocaleString(currentLocale())} events`;
          },
          literal: true,
        })),
      },
      {
        key: 'searchMaxEvents',
        section: 'developer-search-metrics',
        icon: DatabaseIcon,
        name: 'settings.searchMaxEvents',
        type: 'select',
        gatedBy: 'developerTools',
        options: SEARCH_MAX_EVENTS.map((value) => ({
          value,
          get label() {
            return `${Number(value).toLocaleString(currentLocale())} events`;
          },
          literal: true,
        })),
      },
      {
        key: 'timelineEmoteSize',
        section: 'messages',
        icon: SmileyIcon,
        name: 'settings.timelineEmoteSize',
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
        type: 'select',
        options: [
          { value: 'connected', label: 'settings.replyPreviewStyleConnected' },
          { value: 'compact', label: 'settings.replyPreviewStyleCompact' },
          { value: 'expanded', label: 'settings.replyPreviewStyleExpanded' },
        ],
      },
      {
        key: 'captionPosition',
        section: 'messages',
        icon: TextAlignLeftIcon,
        name: 'settings.captionPosition',
        type: 'select',
        options: [
          { value: 'above', label: 'settings.captionPositionAbove' },
          { value: 'below', label: 'settings.captionPositionBelow' },
          { value: 'inline', label: 'settings.captionPositionInline' },
          { value: 'hidden', label: 'settings.captionPositionHidden' },
        ],
      },
      {
        key: 'usernameClick',
        section: 'messages',
        icon: UserCircleIcon,
        name: 'settings.usernameClick',
        type: 'select',
        options: [
          { value: 'mention', label: 'settings.usernameClickMention' },
          { value: 'profile', label: 'settings.usernameClickProfile' },
        ],
      },
      {
        key: 'doubleTapReact',
        section: 'messages',
        icon: HeartIcon,
        name: 'settings.doubleTapReact',
        type: 'boolean',
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
        key: 'weekStart',
        section: 'time-date',
        icon: CalendarBlankIcon,
        name: 'settings.weekStart',
        description: 'settings.weekStartHint',
        type: 'select',
        options: [
          { value: 'sunday', label: 'settings.weekStartSunday' },
          { value: 'monday', label: 'settings.weekStartMonday' },
          { value: 'saturday', label: 'settings.weekStartSaturday' },
        ],
      },
      {
        key: 'hideMembershipEvents',
        section: 'room-events',
        icon: UsersIcon,
        name: 'settings.hideMembershipEvents',
        type: 'boolean',
      },
      {
        key: 'hideProfileChanges',
        section: 'room-events',
        icon: UserCircleIcon,
        name: 'settings.hideProfileChanges',
        type: 'boolean',
      },
      {
        key: 'hideMemberInReadOnly',
        section: 'room-events',
        icon: MegaphoneIcon,
        name: 'settings.hideMemberInReadOnly',
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
        type: 'boolean',
      },
      {
        key: 'showPronounPills',
        section: 'members-pronouns',
        icon: UserCircleIcon,
        name: 'settings.showPronounPills',
        description: 'settings.showPronounPillsHint',
        type: 'boolean',
        gatedBy: 'showPronouns',
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
        key: 'sendAttachmentAsCaption',
        section: 'sending',
        icon: SubtitlesIcon,
        name: 'settings.sendAttachmentAsCaption',
        description: 'settings.sendAttachmentAsCaptionHint',
        type: 'boolean',
      },
      {
        key: 'sendAttachmentsAsGallery',
        section: 'sending',
        icon: SquaresFourIcon,
        name: 'settings.sendAttachmentsAsGallery',
        description: 'settings.sendAttachmentsAsGalleryHint',
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
        type: 'boolean',
      },
      {
        key: 'composerStickerButton',
        section: 'composer-buttons',
        icon: StickerIcon,
        name: 'settings.composerStickerButton',
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
        type: 'boolean',
        unavailable: true,
      },
      {
        key: 'autoplayGifs',
        section: 'playback',
        icon: FilmStripIcon,
        name: 'settings.autoplayGifs',
        type: 'boolean',
      },
      {
        key: 'autoplayStickers',
        section: 'playback',
        icon: StickerIcon,
        name: 'settings.autoplayStickers',
        type: 'boolean',
      },
      {
        key: 'pauseAnimationsWhenInactive',
        section: 'playback',
        icon: PauseIcon,
        name: 'settings.pauseAnimationsWhenInactive',
        type: 'boolean',
      },
      {
        key: 'urlPreviews',
        section: 'previews',
        icon: LinkSimpleIcon,
        name: 'settings.urlPreviews',
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
        type: 'boolean',
        gatedBy: 'clientEmbeds',
      },
      {
        key: 'youtubeEmbeds',
        section: 'embeds',
        icon: YoutubeLogoIcon,
        name: 'settings.youtubeEmbeds',
        type: 'boolean',
        gatedBy: 'clientEmbeds',
      },
      {
        key: 'tiktokEmbeds',
        section: 'embeds',
        icon: TiktokLogoIcon,
        name: 'settings.tiktokEmbeds',
        description: 'settings.tiktokEmbedsHint',
        type: 'boolean',
        gatedBy: 'clientEmbeds',
      },
    ],
  },
  {
    id: 'notifications',
    name: 'settings.notificationsTitle',
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
    icon: PhoneIcon,
    sections: [
      { id: 'call-devices', name: 'settings.callDevicesTitle' },
      { id: 'microphone', name: 'settings.groups.microphone' },
      { id: 'call-camera', name: 'settings.callCameraQuality' },
      { id: 'ringing', name: 'settings.groups.ringing' },
      { id: 'call-button', name: 'settings.groups.callButton' },
      { id: 'call-screens', name: 'settings.groups.callScreens' },
    ],
    items: [
      {
        key: 'callCameraResolution',
        section: 'call-camera',
        icon: MonitorIcon,
        name: 'settings.callCameraResolution',
        description: 'settings.callVideoResolutionHint',
        type: 'select',
        options: callResolutionOptions,
        supported: () => !hasNativeCalls(),
      },
      {
        key: 'callCameraBitrate',
        section: 'call-camera',
        icon: MonitorIcon,
        name: 'settings.callCameraBitrate',
        description: 'settings.callVideoBitrateHint',
        type: 'select',
        options: callBitrateOptions,
        supported: () => !hasNativeCalls(),
      },
      {
        key: 'callCameraCodec',
        section: 'call-camera',
        icon: MonitorIcon,
        name: 'settings.callCameraCodec',
        description: 'settings.callVideoCodecHint',
        type: 'select',
        options: callCodecOptions,
        supported: () => !hasNativeCalls(),
      },
      {
        key: 'callScreenResolution',
        section: 'call-screens',
        icon: MonitorIcon,
        name: 'settings.callScreenResolution',
        description: 'settings.callVideoResolutionHint',
        type: 'select',
        options: callResolutionOptions,
        supported: () => !hasNativeCalls(),
      },
      {
        key: 'callScreenBitrate',
        section: 'call-screens',
        icon: MonitorIcon,
        name: 'settings.callScreenBitrate',
        description: 'settings.callVideoBitrateHint',
        type: 'select',
        options: callBitrateOptions,
        supported: () => !hasNativeCalls(),
      },
      {
        key: 'callScreenCodec',
        section: 'call-screens',
        icon: MonitorIcon,
        name: 'settings.callScreenCodec',
        description: 'settings.callVideoCodecHint',
        type: 'select',
        options: callCodecOptions,
        supported: () => !hasNativeCalls(),
      },
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
        key: 'incomingVoiceIsolation',
        section: 'microphone',
        icon: SpeakerHighIcon,
        name: 'settings.incomingVoiceIsolation',
        description: 'settings.incomingVoiceIsolationHint',
        type: 'boolean',
        supported: () => !hasNativeCalls(),
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
      {
        key: 'callScreenPreview',
        section: 'call-screens',
        icon: MonitorIcon,
        name: 'settings.callScreenPreview',
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
    icon: CodeIcon,
    sections: [
      { id: 'developer-options', name: 'settings.groups.developerTools' },
      { id: 'developer-sync-diagnostics', name: 'settings.developerSyncTitle' },
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
        type: 'boolean',
        gatedBy: 'showHiddenEvents',
      },
      {
        key: 'hiddenEventReactions',
        section: 'developer-options',
        icon: SmileyIcon,
        name: 'settings.hiddenEventReactions',
        type: 'boolean',
        gatedBy: 'showHiddenEvents',
      },
      {
        key: 'hiddenEventRedactions',
        section: 'developer-options',
        icon: TrashIcon,
        name: 'settings.hiddenEventRedactions',
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
