import { untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import type { PresenceView, ProfilePropagationView } from '#src/generated/protocol';
import type { GifProviderSetting } from '#lib/features/gif/providers.js';
import type { MemberSort } from '#lib/features/room/member-listing.js';
import { languageValues, SYSTEM_LANGUAGE } from '#lib/locales.js';
import { readJson, writeJson } from '#lib/platform/local-json.js';
import { customTitleBarDefault } from '#lib/platform/window-decorations.js';

export type TimelineLayout = 'modern' | 'compact' | 'bubble';
export type MessageSpacing = 'compact' | 'cozy' | 'roomy';
export type TimelineEmoteSize = 'default' | '20' | '24' | '32' | '48' | '64';
export type DateFormat = 'auto' | 'dmy' | 'mdy' | 'ymd';
export type ThemeMode = 'system' | 'dark' | 'light';
export type ShowRoomIcon = 'always' | 'sometimes' | 'collapsed' | 'never';
export type SubspaceDepth = '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10';
export const SUBSPACE_DEPTHS = [
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
] as const satisfies readonly SubspaceDepth[];
export type PixelatedImages = 'always' | 'smart' | 'never';
export type PronounPillLimit = '1' | '2' | '3' | 'all';
export type PronounPillLength = '12' | '16' | '24' | 'all';
export type ReadReceiptPlacement = 'message' | 'room';
export type LatchScope = 'off' | 'room' | 'account';
export type ReplyPreviewStyle = 'connected' | 'compact' | 'expanded';
export type CaptionPosition = 'above' | 'below' | 'inline' | 'hidden';
export type CallRingtoneVolume = 'quiet' | 'normal' | 'loud';
export type ComposerButton = 'gif' | 'sticker' | 'emoticon' | 'persona' | 'format';
export const COMPOSER_BUTTONS = [
  'gif',
  'sticker',
  'emoticon',
  'persona',
  'format',
] as const satisfies readonly ComposerButton[];

export interface Preferences {
  language: string;
  layout: TimelineLayout;
  alignOwnMessages: boolean;
  messageSpacing: MessageSpacing;
  timelineEmoteSize: TimelineEmoteSize;
  theme: ThemeMode;
  underlineLinks: boolean;
  renderRoomColors: boolean;
  renderRoomFonts: boolean;
  reducedMotion: boolean;
  pageZoom: number;
  textScale: number;
  highContrast: boolean;
  alwaysShowAltText: boolean;
  twitterEmoji: boolean;
  pixelatedImages: PixelatedImages;
  showRoomIcon: ShowRoomIcon;
  showRoomBanners: boolean;
  roomBannerHeight: number;
  subspaceHierarchyLimit: SubspaceDepth;
  showSearch: boolean;
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
  replyPreviewStyle: ReplyPreviewStyle;
  captionPosition: CaptionPosition;
  hideTypingIndicators: boolean;
  memberSort: MemberSort;
  groupMembersByPresence: boolean;
  filterPronounsByLanguage: boolean;
  showPronouns: boolean;
  pronounPillLimit: PronounPillLimit;
  pronounPillLength: PronounPillLength;

  enterForNewline: boolean;
  mentionInReplies: boolean;
  formattingToolbar: boolean;
  composerFormatButton: boolean;
  richTextComposer: boolean;
  composerGifButton: boolean;
  composerStickerButton: boolean;
  composerEmoteButton: boolean;
  composerVoiceButton: boolean;
  composerButtonOrder: ComposerButton[];
  scheduleInEncryptedRooms: boolean;
  sendAttachmentAsCaption: boolean;
  sendAttachmentsAsGallery: boolean;

  personaPicker: boolean;
  personaProxying: boolean;
  personaLatching: LatchScope;
  personaFallback: boolean;

  sendTypingNotifications: boolean;
  sendReadReceipts: boolean;
  sendPresence: boolean;
  blurMedia: boolean;
  blurAvatars: boolean;
  blurEmotes: boolean;
  presence: PresenceView;
  presenceStatusMessage: string;
  loadingAnimal: string;

  mediaAutoLoad: boolean;
  autoplayGifs: boolean;
  pauseAnimationsWhenInactive: boolean;
  autoplayStickers: boolean;
  gifProvider: GifProviderSetting;
  urlPreviews: boolean;
  themeFileCards: boolean;
  encryptedUrlPreviews: boolean;
  clientEmbeds: boolean;
  encryptedClientEmbeds: boolean;
  youtubeEmbeds: boolean;

  systemNotifications: boolean;
  notificationSounds: boolean;
  notificationSoundVolume: number;
  notifyOnce: boolean;
  backgroundNotificationSounds: boolean;
  notificationContent: boolean;
  notificationEncryptedContent: boolean;
  richPushPayloads: boolean;
  clearNotificationsOnRead: boolean;
  highlightMentions: boolean;
  faviconForMentionsOnly: boolean;
  ringForGroupCalls: boolean;
  alwaysShowCallButton: boolean;
  incomingCallSound: boolean;
  outgoingRingback: boolean;
  callRingtoneVolume: CallRingtoneVolume;
  noiseSuppression: boolean;
  voiceIsolation: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  audioInputDevice: string;
  audioOutputDevice: string;
  videoInputDevice: string;

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
  profileChangePropagation: ProfilePropagationView;

  developerTools: boolean;
  showHiddenEvents: boolean;
  hiddenEventEdits: boolean;
  hiddenEventReactions: boolean;
  hiddenEventRedactions: boolean;
  hiddenEventOther: boolean;
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
  | 'hiddenEventEdits'
  | 'hiddenEventReactions'
  | 'hiddenEventRedactions'
  | 'hiddenEventOther'
>;

const STORAGE_KEY = 'sable-preferences';
const LEGACY_STORAGE_KEY = 'sable-timeline-preferences';

/** The string-valued preferences with a fixed set of accepted values. */
type EnumPreference = Exclude<
  { [K in keyof Preferences]: Preferences[K] extends string ? K : never }[keyof Preferences],
  FreeTextPreference
>;

const ENUMS = {
  language: languageValues,
  layout: ['modern', 'compact', 'bubble'],
  messageSpacing: ['compact', 'cozy', 'roomy'],
  timelineEmoteSize: ['default', '20', '24', '32', '48', '64'],
  theme: ['system', 'dark', 'light'],
  dateFormat: ['auto', 'dmy', 'mdy', 'ymd'],
  gifProvider: ['default', 'klipy', 'tenor', 'giphy'],
  showRoomIcon: ['always', 'sometimes', 'collapsed', 'never'],
  subspaceHierarchyLimit: SUBSPACE_DEPTHS,
  pixelatedImages: ['always', 'smart', 'never'],
  pronounPillLimit: ['1', '2', '3', 'all'],
  pronounPillLength: ['12', '16', '24', 'all'],
  readReceiptPlacement: ['message', 'room'],
  replyPreviewStyle: ['connected', 'compact', 'expanded'],
  captionPosition: ['above', 'below', 'inline', 'hidden'],
  callRingtoneVolume: ['quiet', 'normal', 'loud'],
  memberSort: ['name-asc', 'name-desc', 'newest', 'oldest'],
  personaLatching: ['off', 'room', 'account'],
  presence: ['online', 'unavailable', 'offline'],
  profileChangePropagation: ['all', 'unchanged', 'none'],
} as const satisfies { [K in EnumPreference]?: readonly Preferences[K][] };

/** Strings with no fixed set of values, which `load` would otherwise drop and
    `SelectPreference` would otherwise claim. */
const FREE_TEXT = [
  'audioInputDevice',
  'audioOutputDevice',
  'videoInputDevice',
  'presenceStatusMessage',
  'loadingAnimal',
  'pushGatewayUrl',
  'pushVapidKey',
  'pushAppId',
] as const satisfies readonly (keyof Preferences)[];

export type FreeTextPreference = (typeof FREE_TEXT)[number];

export const PREFERENCE_RANGES = {
  notificationSoundVolume: { min: 0, max: 1 },
  pageZoom: { min: 0.75, max: 1.5 },
  textScale: { min: 0.75, max: 1.5 },
  roomBannerHeight: { min: 56, max: 500 },
} as const satisfies Partial<Record<keyof Preferences, { min: number; max: number }>>;

export type RangePreference = keyof typeof PREFERENCE_RANGES;

const DEFAULTS: Preferences = {
  language: SYSTEM_LANGUAGE,
  layout: 'modern',
  alignOwnMessages: true,
  messageSpacing: 'cozy',
  timelineEmoteSize: 'default',
  theme: 'system',
  underlineLinks: true,
  renderRoomColors: true,
  renderRoomFonts: true,
  reducedMotion: prefersReducedMotion(),
  pageZoom: 1,
  textScale: 1,
  highContrast: false,
  alwaysShowAltText: false,
  twitterEmoji: true,
  pixelatedImages: 'smart',
  showRoomIcon: 'always',
  showRoomBanners: true,
  roomBannerHeight: 190,
  subspaceHierarchyLimit: '3',
  showSearch: false,
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
  replyPreviewStyle: 'connected',
  captionPosition: 'below',
  hideTypingIndicators: false,
  memberSort: 'name-asc',
  groupMembersByPresence: true,
  filterPronounsByLanguage: true,
  showPronouns: true,
  pronounPillLimit: '3',
  pronounPillLength: 'all',

  enterForNewline: false,
  mentionInReplies: true,
  formattingToolbar: false,
  composerFormatButton: true,
  richTextComposer: false,
  composerGifButton: true,
  composerStickerButton: true,
  composerEmoteButton: true,
  composerVoiceButton: true,
  composerButtonOrder: [...COMPOSER_BUTTONS],
  scheduleInEncryptedRooms: true,
  sendAttachmentAsCaption: true,
  sendAttachmentsAsGallery: true,

  personaPicker: true,
  personaProxying: false,
  personaLatching: 'off',
  personaFallback: true,

  sendTypingNotifications: true,
  sendReadReceipts: true,
  sendPresence: true,
  blurMedia: false,
  blurAvatars: false,
  blurEmotes: false,
  presence: 'online',
  presenceStatusMessage: '',
  loadingAnimal: '',

  mediaAutoLoad: true,
  autoplayGifs: true,
  pauseAnimationsWhenInactive: false,
  autoplayStickers: true,
  gifProvider: 'default',
  urlPreviews: false,
  themeFileCards: true,
  encryptedUrlPreviews: false,
  clientEmbeds: false,
  encryptedClientEmbeds: false,
  youtubeEmbeds: false,

  systemNotifications: true,
  notificationSounds: true,
  notificationSoundVolume: 1,
  notifyOnce: true,
  backgroundNotificationSounds: true,
  notificationContent: false,
  notificationEncryptedContent: false,
  richPushPayloads: true,
  clearNotificationsOnRead: true,
  highlightMentions: true,
  faviconForMentionsOnly: false,
  ringForGroupCalls: false,
  alwaysShowCallButton: false,
  incomingCallSound: true,
  outgoingRingback: true,
  callRingtoneVolume: 'normal',
  noiseSuppression: true,
  voiceIsolation: false,
  echoCancellation: true,
  autoGainControl: true,
  audioInputDevice: '',
  audioOutputDevice: '',
  videoInputDevice: '',

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
  profileChangePropagation: 'unchanged',

  developerTools: false,
  showHiddenEvents: false,
  hiddenEventEdits: true,
  hiddenEventReactions: true,
  hiddenEventRedactions: true,
  hiddenEventOther: true,
};

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function read(key: string): Record<string, unknown> | null {
  return readJson(
    key,
    (parsed) =>
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null,
    null
  );
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
    } else if (key === 'composerButtonOrder') {
      if (Array.isArray(value)) {
        const order = value.filter(
          (entry): entry is ComposerButton =>
            typeof entry === 'string' && COMPOSER_BUTTONS.includes(entry as ComposerButton)
        );
        const unique = order.filter((entry, index) => order.indexOf(entry) === index);
        (next as Record<string, unknown>)[key] = [
          ...unique,
          ...COMPOSER_BUTTONS.filter((entry) => !unique.includes(entry)),
        ];
      }
    } else if (key in PREFERENCE_RANGES) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        const { min, max } = PREFERENCE_RANGES[key as RangePreference];
        (next as Record<string, unknown>)[key] = Math.min(max, Math.max(min, value));
      }
    } else if ((FREE_TEXT as readonly string[]).includes(key)) {
      if (typeof value === 'string') (next as Record<string, unknown>)[key] = value;
    } else if (typeof value === 'boolean') {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

function mergeNotificationSwitch(stored: Record<string, unknown>, next: Preferences): Preferences {
  if (stored.desktopNotifications === false) next.systemNotifications = false;
  return next;
}

const LEGACY_FONT_SCALES: Record<string, number> = {
  smallest: 0.75,
  small: 0.9375,
  large: 1.125,
  largest: 1.25,
  huge: 1.5,
};

function mergeFontScale(stored: Record<string, unknown>, next: Preferences): Preferences {
  if (stored.pageZoom !== undefined || typeof stored.fontScale !== 'string') return next;
  next.pageZoom = LEGACY_FONT_SCALES[stored.fontScale] ?? next.pageZoom;
  return next;
}

const explicit = new SvelteSet<keyof Preferences>();

function load(): Preferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };

  const stored = read(STORAGE_KEY) ?? read(LEGACY_STORAGE_KEY);
  if (!stored) return { ...DEFAULTS };

  const loaded = mergeFontScale(
    stored,
    mergeNotificationSwitch(stored, sanitize(stored, DEFAULTS))
  );
  for (const key of PREFERENCE_KEYS) {
    if (key in stored || loaded[key] !== DEFAULTS[key]) explicit.add(key);
  }
  return loaded;
}

export const preferences = $state<Preferences>(load());

export function readReceiptIsPrivate(): boolean {
  return !preferences.sendReadReceipts;
}

export function isExplicitPreference(key: keyof Preferences): boolean {
  return explicit.has(key);
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  preferences[key] = value;
  explicit.add(key);
  persist();
}

export function applyPreferences(
  next: Preferences,
  keys: readonly (keyof Preferences)[] = PREFERENCE_KEYS
): void {
  for (const key of PREFERENCE_KEYS) {
    (preferences as unknown as Record<string, unknown>)[key] = next[key];
  }
  for (const key of keys) explicit.add(key);
  persist();
}

export function applyDeploymentDefaults(raw: Record<string, unknown>): void {
  const defaults = sanitize(raw, preferences);
  for (const key of PREFERENCE_KEYS) {
    if (key in raw && !explicit.has(key)) {
      (preferences as unknown as Record<string, unknown>)[key] = defaults[key];
    }
  }
}

function persist(): void {
  untrack(() => {
    const stored: Partial<Record<keyof Preferences, unknown>> = {};
    for (const key of explicit) stored[key] = preferences[key];
    writeJson(STORAGE_KEY, stored, '[sable settings] preferences not persisted');
  });
}
