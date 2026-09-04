import type { MemberSort } from '#lib/features/room/member-listing.js';
import { customTitleBarDefault } from '#lib/platform/window-decorations.js';

export type TimelineLayout = 'modern' | 'compact' | 'bubble';
export type MessageSpacing = 'compact' | 'cozy' | 'roomy';
export type DateFormat = 'auto' | 'dmy' | 'mdy' | 'ymd';
export type ThemeMode = 'system' | 'dark' | 'light';
export type GifProviderChoice = 'default' | 'klipy' | 'tenor' | 'giphy';
export type ShowRoomIcon = 'always' | 'collapsed' | 'never';
export type FontScale = 'small' | 'default' | 'large' | 'largest';
export type PronounPillLimit = '1' | '2' | '3' | 'all';
export type ReadReceiptPlacement = 'message' | 'room';

export interface Preferences {
  layout: TimelineLayout;
  messageSpacing: MessageSpacing;
  theme: ThemeMode;
  underlineLinks: boolean;
  reducedMotion: boolean;
  fontScale: FontScale;
  highContrast: boolean;
  alwaysShowAltText: boolean;
  showRoomIcon: ShowRoomIcon;
  showRoomBanners: boolean;
  showHome: boolean;
  showUnreadCounts: boolean;
  badgeCountDMsOnly: boolean;
  showPingCounts: boolean;
  uniformIcons: boolean;

  hour24Clock: boolean;
  dateFormat: DateFormat;

  hideMembershipEvents: boolean;
  hideProfileChanges: boolean;
  hideMemberInReadOnly: boolean;
  showTombstoneEvents: boolean;
  hideReadReceipts: boolean;
  readReceiptPlacement: ReadReceiptPlacement;
  hideTypingIndicators: boolean;
  memberSort: MemberSort;
  filterPronounsByLanguage: boolean;
  pronounPillLimit: PronounPillLimit;

  enterForNewline: boolean;
  formattingToolbar: boolean;
  richTextComposer: boolean;

  personaPicker: boolean;
  personaProxying: boolean;
  personaLatching: boolean;
  personaFallback: boolean;

  sendTypingNotifications: boolean;
  sendReadReceipts: boolean;
  sendPresence: boolean;

  mediaAutoLoad: boolean;
  autoplayGifs: boolean;
  gifProvider: GifProviderChoice;
  urlPreviews: boolean;

  desktopNotifications: boolean;
  notificationSounds: boolean;
  notificationContent: boolean;
  notificationEncryptedContent: boolean;
  richPushPayloads: boolean;
  clearNotificationsOnRead: boolean;

  /** Empty falls back to `config.json`; see `hasCompleteOverride`. */
  pushGatewayUrl: string;
  pushVapidKey: string;
  pushAppId: string;

  errorReporting: boolean;
  sessionReplay: boolean;
  /** Distinguishes a declined prompt from one that was never shown. */
  telemetryAsked: boolean;

  autoUpdateCheck: boolean;
  closeToTray: boolean;
  showSystemTrayIcon: boolean;
  useCustomTitleBar: boolean;

  settingsSync: boolean;
  syncDrafts: boolean;

  developerTools: boolean;
  showHiddenEvents: boolean;
  showNonStandardEvents: boolean;
}

/** The subset the timeline reads when deciding which events to render. */
export type TimelinePreferences = Pick<
  Preferences,
  | 'layout'
  | 'hideMembershipEvents'
  | 'hideProfileChanges'
  | 'hideMemberInReadOnly'
  | 'showTombstoneEvents'
  | 'showHiddenEvents'
  | 'showNonStandardEvents'
>;

const STORAGE_KEY = 'sable-preferences';
const LEGACY_STORAGE_KEY = 'sable-timeline-preferences';

const ENUMS = {
  layout: ['modern', 'compact', 'bubble'],
  messageSpacing: ['compact', 'cozy', 'roomy'],
  theme: ['system', 'dark', 'light'],
  dateFormat: ['auto', 'dmy', 'mdy', 'ymd'],
  gifProvider: ['default', 'klipy', 'tenor', 'giphy'],
  showRoomIcon: ['always', 'collapsed', 'never'],
  fontScale: ['small', 'default', 'large', 'largest'],
  pronounPillLimit: ['1', '2', '3', 'all'],
  readReceiptPlacement: ['message', 'room'],
  memberSort: ['name-asc', 'name-desc', 'newest', 'oldest'],
} as const satisfies Partial<Record<keyof Preferences, readonly string[]>>;

/** Strings with no fixed set of values, which `load` would otherwise drop and
    `SelectPreference` would otherwise claim. */
const FREE_TEXT = [
  'pushGatewayUrl',
  'pushVapidKey',
  'pushAppId',
] as const satisfies readonly (keyof Preferences)[];

export type FreeTextPreference = (typeof FREE_TEXT)[number];

const DEFAULTS: Preferences = {
  layout: 'modern',
  messageSpacing: 'cozy',
  theme: 'system',
  underlineLinks: true,
  reducedMotion: prefersReducedMotion(),
  fontScale: 'default',
  highContrast: false,
  alwaysShowAltText: false,
  showRoomIcon: 'always',
  showRoomBanners: true,
  showHome: false,
  showUnreadCounts: false,
  badgeCountDMsOnly: true,
  showPingCounts: true,
  uniformIcons: false,

  hour24Clock: false,
  dateFormat: 'auto',

  hideMembershipEvents: false,
  hideProfileChanges: true,
  hideMemberInReadOnly: true,
  showTombstoneEvents: true,
  hideReadReceipts: false,
  readReceiptPlacement: 'message',
  hideTypingIndicators: false,
  memberSort: 'name-asc',
  filterPronounsByLanguage: true,
  pronounPillLimit: '3',

  enterForNewline: false,
  formattingToolbar: false,
  richTextComposer: true,

  personaPicker: true,
  personaProxying: false,
  personaLatching: false,
  personaFallback: true,

  sendTypingNotifications: true,
  sendReadReceipts: true,
  sendPresence: true,

  mediaAutoLoad: true,
  autoplayGifs: true,
  gifProvider: 'default',
  urlPreviews: false,

  desktopNotifications: false,
  notificationSounds: true,
  notificationContent: false,
  notificationEncryptedContent: false,
  richPushPayloads: true,
  clearNotificationsOnRead: true,

  pushGatewayUrl: '',
  pushVapidKey: '',
  pushAppId: '',

  errorReporting: false,
  sessionReplay: false,
  telemetryAsked: false,

  autoUpdateCheck: true,
  closeToTray: false,
  showSystemTrayIcon: true,
  useCustomTitleBar: customTitleBarDefault(),

  settingsSync: false,
  syncDrafts: true,

  developerTools: false,
  showHiddenEvents: false,
  showNonStandardEvents: false,
};

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function read(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export const PREFERENCE_KEYS = Object.keys(DEFAULTS) as (keyof Preferences)[];

export function sanitize(stored: Record<string, unknown>, base: Preferences): Preferences {
  const next = { ...base };
  for (const key of PREFERENCE_KEYS) {
    const value = stored[key];
    const allowed: readonly string[] | undefined =
      key in ENUMS ? ENUMS[key as keyof typeof ENUMS] : undefined;
    if (allowed) {
      if (typeof value === 'string' && allowed.includes(value)) {
        (next as Record<string, unknown>)[key] = value;
      }
    } else if ((FREE_TEXT as readonly string[]).includes(key)) {
      if (typeof value === 'string') (next as Record<string, unknown>)[key] = value;
    } else if (typeof value === 'boolean') {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

function load(): Preferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };

  const stored = read(STORAGE_KEY) ?? read(LEGACY_STORAGE_KEY);
  if (!stored) return { ...DEFAULTS };

  return sanitize(stored, DEFAULTS);
}

export const preferences = $state<Preferences>(load());

export function readReceiptIsPrivate(): boolean {
  return !preferences.sendReadReceipts;
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  preferences[key] = value;
  persist();
}

export function applyPreferences(next: Preferences): void {
  for (const key of PREFERENCE_KEYS) {
    (preferences as unknown as Record<string, unknown>)[key] = next[key];
  }
  persist();
}

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.debug('[sable settings] preferences not persisted', error);
  }
}
