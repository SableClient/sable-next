import { ACCOUNT_PREFERENCES } from '#lib/config/account-config.js';
import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import type {
  MediaPreviewsView,
  PresenceView,
  ProfilePropagationView,
} from '#src/generated/protocol';
import type { GifProviderSetting } from '#lib/gif/providers.js';
import type { MemberSort } from '#lib/rooms/member-listing.js';
import type { RoomSort } from '#lib/rooms/room-sort.js';
import { SYSTEM_TIME_ZONE, timeZoneValues } from '#lib/ui/time-zones.js';
import { languageValues, SYSTEM_LANGUAGE } from '#lib/locales.js';
import { readJson, writeJson } from '#lib/platform/local-json.js';
import { isNightlyBuild } from '#lib/platform/build-channel.js';
import { customTitleBarDefault } from '#lib/platform/window-decorations.js';
import type { BadgeNotificationMode } from '#lib/rooms/unread.js';
import { migrateSettings, SETTINGS_SCHEMA } from './migrations.js';

export type { BadgeNotificationMode };

export type ThreadPresentation = 'timeline' | 'panel';
export type TimelineLayout = 'modern' | 'compact' | 'bubble';
export type MessageSpacing = 'none' | 'compact' | 'cozy' | 'roomy';
export type MediaAutoLoad = MediaPreviewsView;
export type ImageMetadata = 'location' | 'all' | 'keep';
export type TimelineEmoteSize = 'default' | '20' | '24' | '32' | '48' | '64';
export type DateFormat = 'auto' | 'dmy' | 'mdy' | 'ymd';
export type WeekStart = 'sunday' | 'monday' | 'saturday';
export type ThemeMode = 'system' | 'dark' | 'light';
export type ShowRoomIcon = 'always' | 'sometimes' | 'collapsed' | 'never';
export type SearchIndexLimit = '128' | '256' | '512' | '1024' | '2048' | '4096';
export type PersonaPickerSortOrder = 'manual' | 'alphabetical-asc' | 'alphabetical-desc' | 'recent';

export const SEARCH_INDEX_LIMITS: readonly SearchIndexLimit[] = [
  '128',
  '256',
  '512',
  '1024',
  '2048',
  '4096',
];
export const CORE_LOG_LEVELS = ['default', 'debug'] as const;
export const SEARCH_CRAWL_PAUSES = ['1', '2', '3', '5', '10', '30'] as const;
export const SEARCH_TRICKLE_PAUSES = ['5', '10', '30', '60'] as const;
export const SEARCH_FLUSH_INTERVALS = ['20', '60', '120', '300'] as const;
export const SEARCH_BATCH_SIZES = ['25', '50', '100'] as const;
export const SEARCH_BASE_EVENTS = ['5000', '10000', '20000', '50000'] as const;
export const SEARCH_MAX_EVENTS = ['50000', '100000', '200000', '500000'] as const;
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
export type NameColorCorrection = 'strong' | 'weak' | 'off';
export type PronounPillLimit = '1' | '2' | '3' | 'all';
export type PronounPillLength = '12' | '16' | '24' | 'all';
export type ReadReceiptPlacement = 'message' | 'room';
export type PersonaSelectionScope = 'account' | 'space' | 'room' | 'picker';
export type ReplyPreviewStyle = 'connected' | 'compact' | 'expanded';
export type CaptionPosition = 'above' | 'below' | 'inline' | 'hidden';
export type UsernameClick = 'mention' | 'profile';
export const CALL_MODES = ['auto', 'legacy', 'compatibility', 'matrix_2'] as const;
export type CallModePreference = (typeof CALL_MODES)[number];
export const CALL_INPUT_MODES = ['voice-activity', 'push-to-talk'] as const;
export type CallInputMode = (typeof CALL_INPUT_MODES)[number];
export const CALL_VIDEO_RESOLUTIONS = [
  'auto',
  '360',
  '480',
  '720',
  '1080',
  '1440',
  '2160',
] as const;
export const CALL_VIDEO_BITRATES = [
  'auto',
  '250',
  '500',
  '1000',
  '2000',
  '4000',
  '8000',
  '16000',
] as const;
export const CALL_VIDEO_CODECS = ['auto', 'vp8', 'h264', 'vp9', 'av1'] as const;
export const CALL_SCREEN_FRAMERATES = ['auto', '15', '30', '60'] as const;
export const WEBRTC_IP_POLICIES = [
  'default',
  'default_public_and_private_interfaces',
  'default_public_interface_only',
  'disable_non_proxied_udp',
] as const;
export const UPDATE_CHANNELS = ['stable', 'nightly'] as const;
export const PUSH_INACTIVE_TIMEOUTS = ['off', '1', '5', '10', '15', '30'] as const;
export type PushInactiveTimeout = (typeof PUSH_INACTIVE_TIMEOUTS)[number];
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
export type WebRtcIpPolicy = (typeof WEBRTC_IP_POLICIES)[number];
export type CallScreenFramerate = (typeof CALL_SCREEN_FRAMERATES)[number];
export type CallVideoResolution = (typeof CALL_VIDEO_RESOLUTIONS)[number];
export type CallVideoBitrate = (typeof CALL_VIDEO_BITRATES)[number];
export type CallVideoCodec = (typeof CALL_VIDEO_CODECS)[number];
export type ComposerForm = 'short' | 'adaptive' | 'tall';
export type EnterKey = 'adaptive' | 'newline' | 'send';
export const COMPOSER_ACTIONS = ['gif', 'sticker', 'emoticon', 'persona', 'format'] as const;
export type ComposerAction = (typeof COMPOSER_ACTIONS)[number];
export const DEARROW_THUMBNAIL_FALLBACKS = ['random', 'original', 'youtube_autogen'] as const;
export type DearrowThumbnailFallback = (typeof DEARROW_THUMBNAIL_FALLBACKS)[number];
export const YOUTUBE_THUMBNAIL_POSITIONS = ['start', 'middle', 'end'] as const;
export type YoutubeThumbnailPosition = (typeof YOUTUBE_THUMBNAIL_POSITIONS)[number];

export const COMPOSER_SEPARATOR_MAX = 9;
export type ComposerSeparatorId = `separator:${number}`;

export type ComposerButton = ComposerAction | 'separator' | ComposerSeparatorId;

export function isComposerSeparator(id: string): id is 'separator' | ComposerSeparatorId {
  return id === 'separator' || /^separator:\d+$/.test(id);
}

export function composerSeparatorId(index: number): ComposerSeparatorId {
  return `separator:${index}`;
}

export function composerSeparatorCount(order: readonly ComposerButton[]): number {
  return order.filter(isComposerSeparator).length;
}

function normalizeComposerOrder(order: readonly unknown[]): ComposerButton[] {
  const result: ComposerButton[] = [];
  for (const entry of order) {
    if (typeof entry !== 'string') continue;
    const id = entry === 'separator' ? 'separator:0' : entry;
    if (result.includes(id as ComposerButton)) continue;
    if ((COMPOSER_ACTIONS as readonly string[]).includes(id)) result.push(id as ComposerAction);
    else if (isComposerSeparator(id)) {
      const index = Number(id.slice('separator:'.length));
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < COMPOSER_SEPARATOR_MAX &&
        composerSeparatorCount(result) < COMPOSER_SEPARATOR_MAX
      )
        result.push(id);
    }
  }
  for (const action of COMPOSER_ACTIONS) if (!result.includes(action)) result.push(action);
  return result;
}

export function withComposerSeparatorCount(
  order: readonly ComposerButton[],
  count: number
): ComposerButton[] {
  const wanted = Math.min(
    COMPOSER_SEPARATOR_MAX,
    Math.max(0, Math.floor(Number.isFinite(count) ? count : 0))
  );
  const result = normalizeComposerOrder(order);
  const current = composerSeparatorCount(result);
  if (current > wanted) {
    let remaining = wanted;
    return result.filter((id) => !isComposerSeparator(id) || remaining-- > 0);
  }
  const added = Array.from({ length: COMPOSER_SEPARATOR_MAX }, (_, index) =>
    composerSeparatorId(index)
  )
    .filter((id) => !result.includes(id))
    .slice(0, wanted - current);
  let insertAt = result.length;
  while (insertAt > 0 && !isComposerSeparator(result[insertAt - 1])) insertAt--;
  if (insertAt === 0) {
    insertAt = result.length;
    while (
      insertAt > 0 &&
      (result[insertAt - 1] === 'persona' || result[insertAt - 1] === 'format')
    )
      insertAt -= 1;
  }
  result.splice(insertAt, 0, ...added);
  return result;
}

export const COMPOSER_BUTTONS = [
  'gif',
  'sticker',
  'emoticon',
  'separator:0',
  'persona',
  'format',
] as const satisfies readonly ComposerButton[];

export interface Preferences {
  language: string;
  layout: TimelineLayout;
  threadPresentation: ThreadPresentation;
  alignOwnMessages: boolean;
  avatarsInMessageHeaders: boolean;
  messageSpacing: MessageSpacing;
  timelineEmoteSize: TimelineEmoteSize;
  theme: ThemeMode;
  quickCss: string;
  fontFamily: string;
  fontFamilyMono: string;
  codeLigatures: boolean;
  underlineLinks: boolean;
  renderRoomColors: boolean;
  renderProfileColors: boolean;
  reducedMotion: boolean;
  pageZoom: number;
  textScale: number;
  highContrast: boolean;
  alwaysShowAltText: boolean;
  twitterEmoji: boolean;
  pixelatedImages: PixelatedImages;
  nameColorCorrection: NameColorCorrection;
  showRoomIcon: ShowRoomIcon;
  showRoomBanners: boolean;
  showDmTopics: boolean;
  roomBannerHeight: number;
  subspaceHierarchyLimit: SubspaceDepth;
  searchIndexLimit: SearchIndexLimit;
  coreLogLevel: (typeof CORE_LOG_LEVELS)[number];
  searchCrawlPause: (typeof SEARCH_CRAWL_PAUSES)[number];
  searchTricklePause: (typeof SEARCH_TRICKLE_PAUSES)[number];
  searchFlushInterval: (typeof SEARCH_FLUSH_INTERVALS)[number];
  searchBatchSize: (typeof SEARCH_BATCH_SIZES)[number];
  searchBaseEvents: (typeof SEARCH_BASE_EVENTS)[number];
  searchMaxEvents: (typeof SEARCH_MAX_EVENTS)[number];
  searchCrawler: boolean;
  searchUnmeteredOnly: boolean;
  searchSharing: boolean;
  serverSearch: boolean;
  showHome: boolean;
  restoreLastRoom: boolean;
  showSearch: boolean;
  showUnreadCounts: boolean;
  badgeCountDMsOnly: boolean;
  showEasterEggs: boolean;
  showPingCounts: boolean;
  showUnreadDots: boolean;
  uniformIcons: boolean;
  tintRoomIcons: boolean;
  showSpaceEvents: boolean;

  hour24Clock: boolean;
  dateFormat: DateFormat;
  timeZone: string;
  weekStart: WeekStart;

  hideMembershipEvents: boolean;
  hideProfileChanges: boolean;
  hideTopicChanges: boolean;
  hideMemberInReadOnly: boolean;
  showTombstoneEvents: boolean;
  openRoomsAtUnread: boolean;
  jumpToLatestOnSend: boolean;
  hideReadReceipts: boolean;
  readReceiptPlacement: ReadReceiptPlacement;
  replyPreviewStyle: ReplyPreviewStyle;
  captionPosition: CaptionPosition;
  usernameClick: UsernameClick;
  doubleTapReact: boolean;
  messageSwipeAction: 'reply' | 'members';
  showSingleReactionCount: boolean;
  showAllTimestamps: boolean;
  showRoleTooltip: boolean;
  hideMessageShields: boolean;
  doubleTapReaction: string;
  hideTypingIndicators: boolean;
  memberSort: MemberSort;
  roomSort: RoomSort;
  directSort: RoomSort;
  groupMembersByPresence: boolean;
  filterPronounsByLanguage: boolean;
  showPronouns: boolean;
  showPronounPills: boolean;
  pronounPillLimit: PronounPillLimit;
  pronounPillLength: PronounPillLength;

  composerForm: ComposerForm;
  alwaysInlineEditor: boolean;
  enterForNewline: EnterKey;
  sedEdits: boolean;
  inlineEditing: boolean;
  mentionInReplies: boolean;
  formattingToolbar: boolean;
  composerFormatButton: boolean;
  richTextComposer: boolean;
  composerSpellcheck: boolean;
  composerAutocapitalize: boolean;
  emoticonToEmoji: boolean;
  composerGifButton: boolean;
  composerStickerButton: boolean;
  composerEmoteButton: boolean;
  composerVoiceButton: boolean;
  composerButtonOrder: ComposerButton[];
  scheduleInEncryptedRooms: boolean;
  sendAttachmentAsCaption: boolean;
  sendAttachmentsAsGallery: boolean;
  imageMetadata: ImageMetadata;

  personaPicker: boolean;
  personaPickerSortOrder: PersonaPickerSortOrder;
  personaPickerLeftSide: boolean;
  personaProxying: boolean;
  personaSelectionScope: PersonaSelectionScope;
  personaKeepAfterShorthand: boolean;
  personaFallback: boolean;
  personaGrid: boolean;
  personaAlternateAvatar: boolean;

  sendTypingNotifications: boolean;
  sendReadReceipts: boolean;
  sendPresence: boolean;
  blurMedia: boolean;
  blurAvatars: boolean;
  blurEmotes: boolean;
  presence: PresenceView;
  presenceStatusMessage: string;
  loadingAnimal: string;

  mediaAutoLoad: MediaAutoLoad;
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
  useDearrow: boolean;
  dearrowThumbnailFallback: DearrowThumbnailFallback;
  youtubeThumbnailPosition: YoutubeThumbnailPosition;
  tiktokEmbeds: boolean;
  instagramEmbeds: boolean;

  systemNotifications: boolean;
  badgeDefaultDirect: BadgeNotificationMode;
  badgeDefaultGroup: BadgeNotificationMode;
  notificationSounds: boolean;
  notifyOnce: boolean;
  pushInactiveTimeout: PushInactiveTimeout;
  backgroundNotificationSounds: boolean;
  notificationContent: boolean;
  notificationEncryptedContent: boolean;
  richPushPayloads: boolean;
  clearNotificationsOnRead: boolean;
  highlightMentions: boolean;
  faviconForMentionsOnly: boolean;
  ringForGroupCalls: boolean;
  alwaysShowCallButton: boolean;
  callScreenPreview: boolean;
  callMode: CallModePreference;
  callServiceUrl: string;
  incomingCallSound: boolean;
  outgoingRingback: boolean;
  callMicrophoneMuted: boolean;
  callInputMode: CallInputMode;
  callGlobalShortcuts: boolean;
  noiseSuppression: boolean;
  voiceIsolation: boolean;
  incomingVoiceIsolation: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  audioInputDevice: string;
  audioOutputDevice: string;
  videoInputDevice: string;
  callCameraResolution: CallVideoResolution;
  callCameraBitrate: CallVideoBitrate;
  callCameraCodec: CallVideoCodec;
  callScreenResolution: CallVideoResolution;
  callScreenBitrate: CallVideoBitrate;
  callScreenFramerate: CallScreenFramerate;
  callScreenCodec: CallVideoCodec;
  callSimulcast: boolean;

  /** Empty falls back to `config.json`; see `hasCompleteOverride`. */
  pushGatewayUrl: string;
  pushVapidKey: string;
  pushAppId: string;
  /** Empty falls back to `unifiedPushEmbeddedServerUrl` in `config.json`. */
  pushEmbeddedServerUrl: string;

  errorReporting: boolean;
  sessionReplay: boolean;
  /** Distinguishes a declined prompt from one that was never shown. */
  telemetryAsked: boolean;

  soundsNotificationVolume: number;
  soundsCameraOnVolume: number;
  soundsCameraOffVolume: number;
  soundsMicOnVolume: number;
  soundsMicOffVolume: number;
  soundsDeafenOnVolume: number;
  soundsDeafenOffVolume: number;
  soundsScreenshareStartVolume: number;
  soundsScreenshareStopVolume: number;
  soundsCallJoinVolume: number;
  soundsCallLeaveVolume: number;
  soundsIncomingCallVolume: number;
  soundsOutgoingCallVolume: number;

  autoUpdateCheck: boolean;
  updateChannel: UpdateChannel;
  closeToTray: boolean;
  askDownloadLocation: boolean;
  minimizeToTray: boolean;
  showSystemTrayIcon: boolean;
  useCustomTitleBar: boolean;
  hardwareAcceleration: boolean;
  hardwareVideoEncode: boolean;
  hardwareVideoDecode: boolean;
  smoothScrolling: boolean;
  webRtcIpPolicy: WebRtcIpPolicy;
  launchAtLogin: boolean;
  startMinimized: boolean;

  settingsSync: boolean;
  syncDrafts: boolean;
  profileChangePropagation: ProfilePropagationView;

  developerTools: boolean;
  callStatsOverlay: boolean;
  callDebugOverlay: boolean;
  showHiddenEvents: boolean;
  hiddenEventsHeaderToggle: boolean;
  hiddenEventEdits: boolean;
  hiddenEventReactions: boolean;
  hiddenEventRedactions: boolean;
  hiddenEventOther: boolean;
  showTranslationStrings: boolean;
}

/** The subset the timeline reads when deciding which events to render. */
export type TimelinePreferences = Pick<
  Preferences,
  | 'layout'
  | 'hideMembershipEvents'
  | 'hideProfileChanges'
  | 'hideTopicChanges'
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
  mediaAutoLoad: ['on', 'private', 'off'],
  imageMetadata: ['location', 'all', 'keep'],
  language: languageValues,
  layout: ['modern', 'compact', 'bubble'],
  threadPresentation: ['timeline', 'panel'],
  messageSpacing: ['none', 'compact', 'cozy', 'roomy'],
  timelineEmoteSize: ['default', '20', '24', '32', '48', '64'],
  theme: ['system', 'dark', 'light'],
  dateFormat: ['auto', 'dmy', 'mdy', 'ymd'],
  timeZone: timeZoneValues(),
  enterForNewline: ['adaptive', 'newline', 'send'],
  composerForm: ['short', 'adaptive', 'tall'],
  messageSwipeAction: ['reply', 'members'],
  weekStart: ['sunday', 'monday', 'saturday'],
  gifProvider: ['default', 'klipy', 'tenor', 'giphy'],
  showRoomIcon: ['always', 'sometimes', 'collapsed', 'never'],
  subspaceHierarchyLimit: SUBSPACE_DEPTHS,
  searchIndexLimit: SEARCH_INDEX_LIMITS,
  coreLogLevel: CORE_LOG_LEVELS,
  searchCrawlPause: SEARCH_CRAWL_PAUSES,
  searchTricklePause: SEARCH_TRICKLE_PAUSES,
  searchFlushInterval: SEARCH_FLUSH_INTERVALS,
  searchBatchSize: SEARCH_BATCH_SIZES,
  searchBaseEvents: SEARCH_BASE_EVENTS,
  searchMaxEvents: SEARCH_MAX_EVENTS,
  pixelatedImages: ['always', 'smart', 'never'],
  nameColorCorrection: ['strong', 'weak', 'off'],
  pronounPillLimit: ['1', '2', '3', 'all'],
  pronounPillLength: ['12', '16', '24', 'all'],
  readReceiptPlacement: ['message', 'room'],
  replyPreviewStyle: ['connected', 'compact', 'expanded'],
  captionPosition: ['above', 'below', 'inline', 'hidden'],
  usernameClick: ['mention', 'profile'],
  callMode: CALL_MODES,
  callInputMode: CALL_INPUT_MODES,
  callCameraResolution: CALL_VIDEO_RESOLUTIONS,
  callCameraBitrate: CALL_VIDEO_BITRATES,
  callCameraCodec: CALL_VIDEO_CODECS,
  callScreenResolution: CALL_VIDEO_RESOLUTIONS,
  callScreenBitrate: CALL_VIDEO_BITRATES,
  callScreenFramerate: CALL_SCREEN_FRAMERATES,
  callScreenCodec: CALL_VIDEO_CODECS,
  webRtcIpPolicy: WEBRTC_IP_POLICIES,
  updateChannel: UPDATE_CHANNELS,
  pushInactiveTimeout: PUSH_INACTIVE_TIMEOUTS,
  dearrowThumbnailFallback: DEARROW_THUMBNAIL_FALLBACKS,
  youtubeThumbnailPosition: YOUTUBE_THUMBNAIL_POSITIONS,
  badgeDefaultDirect: ['all', 'mentions', 'quiet'],
  badgeDefaultGroup: ['all', 'mentions', 'quiet'],
  memberSort: ['name-asc', 'name-desc', 'newest', 'oldest'],
  roomSort: ['recent', 'name-asc', 'name-desc'],
  directSort: ['recent', 'name-asc', 'name-desc'],
  personaSelectionScope: ['account', 'space', 'room', 'picker'],
  personaPickerSortOrder: ['manual', 'alphabetical-asc', 'alphabetical-desc', 'recent'],
  presence: ['online', 'unavailable', 'offline'],
  profileChangePropagation: ['all', 'unchanged', 'none'],
} as const satisfies { [K in EnumPreference]?: readonly Preferences[K][] };

/** Strings with no fixed set of values, which `load` would otherwise drop and
    `SelectPreference` would otherwise claim. */
const FREE_TEXT = [
  'quickCss',
  'fontFamily',
  'fontFamilyMono',
  'audioInputDevice',
  'callServiceUrl',
  'audioOutputDevice',
  'videoInputDevice',
  'presenceStatusMessage',
  'loadingAnimal',
  'doubleTapReaction',
  'pushGatewayUrl',
  'pushVapidKey',
  'pushAppId',
  'pushEmbeddedServerUrl',
] as const satisfies readonly (keyof Preferences)[];

export type FreeTextPreference = (typeof FREE_TEXT)[number];

export const PREFERENCE_RANGES = {
  soundsNotificationVolume: { min: 0, max: 2.0 },
  soundsCameraOnVolume: { min: 0, max: 2.0 },
  soundsCameraOffVolume: { min: 0, max: 2.0 },
  soundsMicOnVolume: { min: 0, max: 2.0 },
  soundsMicOffVolume: { min: 0, max: 2.0 },
  soundsDeafenOnVolume: { min: 0, max: 2.0 },
  soundsDeafenOffVolume: { min: 0, max: 2.0 },
  soundsScreenshareStartVolume: { min: 0, max: 2.0 },
  soundsScreenshareStopVolume: { min: 0, max: 2.0 },
  soundsCallJoinVolume: { min: 0, max: 2.0 },
  soundsCallLeaveVolume: { min: 0, max: 2.0 },
  soundsIncomingCallVolume: { min: 0, max: 2.0 },
  soundsOutgoingCallVolume: { min: 0, max: 2.0 },
  pageZoom: { min: 0.75, max: 1.5 },
  textScale: { min: 0.75, max: 1.5 },
  roomBannerHeight: { min: 56, max: 500 },
} as const satisfies Partial<Record<keyof Preferences, { min: number; max: number }>>;

export type RangePreference = keyof typeof PREFERENCE_RANGES;

const DEFAULTS: Preferences = {
  language: SYSTEM_LANGUAGE,
  layout: 'modern',
  threadPresentation: 'timeline',
  alignOwnMessages: true,
  avatarsInMessageHeaders: true,
  messageSpacing: 'cozy',
  timelineEmoteSize: 'default',
  theme: 'system',
  quickCss: '',
  fontFamily: '',
  fontFamilyMono: '',
  codeLigatures: true,
  underlineLinks: true,
  renderRoomColors: true,
  renderProfileColors: true,
  reducedMotion: prefersReducedMotion(),
  pageZoom: 1,
  textScale: 1,
  highContrast: false,
  alwaysShowAltText: false,
  twitterEmoji: true,
  pixelatedImages: 'never',
  nameColorCorrection: 'strong',
  showRoomIcon: 'always',
  showRoomBanners: true,
  showDmTopics: true,
  roomBannerHeight: 190,
  subspaceHierarchyLimit: '3',
  searchIndexLimit: '512',
  coreLogLevel: 'default',
  searchCrawlPause: '3',
  searchTricklePause: '10',
  searchFlushInterval: '60',
  searchBatchSize: '50',
  searchBaseEvents: '20000',
  searchMaxEvents: '50000',
  searchCrawler: true,
  searchUnmeteredOnly: true,
  searchSharing: true,
  serverSearch: true,
  showHome: false,
  restoreLastRoom: true,
  showSearch: false,
  showUnreadCounts: false,
  badgeCountDMsOnly: true,
  showEasterEggs: true,
  showPingCounts: true,
  showUnreadDots: true,
  uniformIcons: false,
  tintRoomIcons: false,
  showSpaceEvents: true,

  hour24Clock: false,
  dateFormat: 'auto',
  timeZone: SYSTEM_TIME_ZONE,
  weekStart: 'sunday',

  hideMembershipEvents: false,
  hideProfileChanges: true,
  hideTopicChanges: false,
  hideMemberInReadOnly: true,
  showTombstoneEvents: true,
  openRoomsAtUnread: true,
  jumpToLatestOnSend: false,
  hideReadReceipts: false,
  readReceiptPlacement: 'message',
  replyPreviewStyle: 'connected',
  captionPosition: 'below',
  usernameClick: 'mention',
  doubleTapReact: true,
  messageSwipeAction: 'reply',
  showSingleReactionCount: true,
  showAllTimestamps: false,
  showRoleTooltip: false,
  hideMessageShields: false,
  doubleTapReaction: '❤️',
  hideTypingIndicators: false,
  memberSort: 'name-asc',
  roomSort: 'recent',
  directSort: 'recent',
  groupMembersByPresence: true,
  filterPronounsByLanguage: true,
  showPronouns: true,
  showPronounPills: true,
  pronounPillLimit: '3',
  pronounPillLength: 'all',

  composerForm: 'tall',
  alwaysInlineEditor: false,
  enterForNewline: 'adaptive',
  sedEdits: false,
  inlineEditing: false,
  mentionInReplies: true,
  formattingToolbar: false,
  composerFormatButton: true,
  richTextComposer: false,
  composerSpellcheck: true,
  composerAutocapitalize: true,
  emoticonToEmoji: false,
  composerGifButton: true,
  composerStickerButton: true,
  composerEmoteButton: true,
  composerVoiceButton: true,
  composerButtonOrder: [...COMPOSER_BUTTONS],
  scheduleInEncryptedRooms: true,
  sendAttachmentAsCaption: true,
  sendAttachmentsAsGallery: false,
  imageMetadata: 'location',

  personaPicker: true,
  personaPickerSortOrder: 'recent',
  personaPickerLeftSide: false,
  personaProxying: false,
  personaSelectionScope: 'picker',
  personaKeepAfterShorthand: false,
  personaFallback: true,
  personaGrid: true,
  personaAlternateAvatar: false,

  sendTypingNotifications: true,
  sendReadReceipts: true,
  sendPresence: true,
  blurMedia: false,
  blurAvatars: false,
  blurEmotes: false,
  presence: 'online',
  presenceStatusMessage: '',
  loadingAnimal: '',

  mediaAutoLoad: 'on',
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
  useDearrow: false,
  dearrowThumbnailFallback: 'youtube_autogen',
  youtubeThumbnailPosition: 'middle',
  tiktokEmbeds: false,
  instagramEmbeds: false,

  systemNotifications: true,
  badgeDefaultDirect: 'all',
  badgeDefaultGroup: 'mentions',
  notificationSounds: true,
  notifyOnce: true,
  pushInactiveTimeout: '1',
  backgroundNotificationSounds: true,
  notificationContent: false,
  notificationEncryptedContent: false,
  richPushPayloads: true,
  clearNotificationsOnRead: true,
  highlightMentions: true,
  faviconForMentionsOnly: false,
  ringForGroupCalls: false,
  alwaysShowCallButton: false,
  callScreenPreview: true,
  callMode: 'auto',
  callServiceUrl: '',
  incomingCallSound: true,
  outgoingRingback: true,
  callMicrophoneMuted: false,
  callInputMode: 'voice-activity',
  callGlobalShortcuts: true,
  noiseSuppression: true,
  voiceIsolation: false,
  incomingVoiceIsolation: false,
  echoCancellation: true,
  autoGainControl: true,
  audioInputDevice: '',
  audioOutputDevice: '',
  videoInputDevice: '',
  callCameraResolution: 'auto',
  callCameraBitrate: 'auto',
  callCameraCodec: 'auto',
  callScreenResolution: '720',
  callScreenBitrate: 'auto',
  callScreenFramerate: '30',
  callScreenCodec: 'h264',
  callSimulcast: true,

  pushGatewayUrl: '',
  pushVapidKey: '',
  pushAppId: '',
  pushEmbeddedServerUrl: '',

  soundsNotificationVolume: 1,
  soundsCameraOnVolume: 1,
  soundsCameraOffVolume: 1,
  soundsMicOnVolume: 1,
  soundsMicOffVolume: 1,
  soundsDeafenOnVolume: 1,
  soundsDeafenOffVolume: 1,
  soundsScreenshareStartVolume: 1,
  soundsScreenshareStopVolume: 1,
  soundsCallJoinVolume: 1,
  soundsCallLeaveVolume: 1,
  soundsIncomingCallVolume: 1,
  soundsOutgoingCallVolume: 1,

  errorReporting: false,
  sessionReplay: false,
  telemetryAsked: false,

  autoUpdateCheck: true,
  updateChannel: isNightlyBuild() ? 'nightly' : 'stable',
  closeToTray: false,
  askDownloadLocation: true,
  minimizeToTray: false,
  showSystemTrayIcon: true,
  useCustomTitleBar: customTitleBarDefault(),
  hardwareAcceleration: true,
  hardwareVideoEncode: true,
  hardwareVideoDecode: true,
  smoothScrolling: true,
  webRtcIpPolicy: 'default',
  launchAtLogin: false,
  startMinimized: false,

  settingsSync: false,
  syncDrafts: true,
  profileChangePropagation: 'unchanged',

  developerTools: false,
  callStatsOverlay: false,
  callDebugOverlay: true,
  showHiddenEvents: false,
  hiddenEventsHeaderToggle: false,
  hiddenEventEdits: true,
  hiddenEventReactions: true,
  hiddenEventRedactions: true,
  hiddenEventOther: true,
  showTranslationStrings: false,
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

export type PreferenceSpec = { key: keyof Preferences; default: unknown } & (
  | { type: 'boolean' | 'text' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'number'; min: number; max: number }
  | { type: 'list'; values: readonly string[] }
);

export function preferenceSpecs(): PreferenceSpec[] {
  return PREFERENCE_KEYS.map((key): PreferenceSpec => {
    const base = { key, default: DEFAULTS[key] };
    if (key in ENUMS) return { ...base, type: 'enum', values: ENUMS[key as keyof typeof ENUMS] };
    if (key in PREFERENCE_RANGES)
      return { ...base, type: 'number', ...PREFERENCE_RANGES[key as RangePreference] };
    if (key === 'composerButtonOrder')
      return {
        ...base,
        type: 'list',
        values: [
          ...COMPOSER_ACTIONS,
          ...Array.from({ length: COMPOSER_SEPARATOR_MAX }, (_, i) => composerSeparatorId(i)),
        ],
      };
    if ((FREE_TEXT as readonly string[]).includes(key)) return { ...base, type: 'text' };
    return { ...base, type: 'boolean' };
  });
}

function legacyEnterKey(value: unknown): unknown {
  return typeof value === 'boolean' ? (value ? 'newline' : 'adaptive') : value;
}

export function sanitize(stored: Record<string, unknown>, base: Preferences): Preferences {
  const next = { ...base };
  for (const key of PREFERENCE_KEYS) {
    let value = key === 'enterForNewline' ? legacyEnterKey(stored[key]) : stored[key];
    if (key === 'mediaAutoLoad' && typeof value === 'boolean') value = value ? 'on' : 'off';
    if (key === 'callMode' && value === undefined && stored.forceLegacyCalls === true) {
      value = 'legacy';
    }
    const allowed: readonly string[] | undefined =
      key in ENUMS ? ENUMS[key as keyof typeof ENUMS] : undefined;
    if (allowed) {
      if (typeof value === 'string' && allowed.includes(value)) {
        (next as Record<string, unknown>)[key] = value;
      }
    } else if (key === 'composerButtonOrder') {
      if (Array.isArray(value)) {
        next.composerButtonOrder = normalizeComposerOrder(value);
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

const explicit = new SvelteSet<keyof Preferences>();
const locked = new SvelteSet<keyof Preferences>();
const userValues = new SvelteMap<keyof Preferences, unknown>();
let deploymentDefaults: Partial<Preferences> = {};
let deploymentLocks: Partial<Preferences> = {};
let accountDefaults: Partial<Preferences> = {};
let accountLocks = $state.raw<Partial<Preferences>>({});

function load(): Preferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };

  const current = read(STORAGE_KEY) ?? read(LEGACY_STORAGE_KEY);
  if (!current) return { ...DEFAULTS };

  const stored = migrateSettings(current, current.schema);
  const loaded = sanitize(stored, DEFAULTS);
  for (const key of PREFERENCE_KEYS) {
    if (key in stored || loaded[key] !== DEFAULTS[key]) explicit.add(key);
  }
  return loaded;
}

export const preferences = $state<Preferences>(load());
for (const key of explicit) userValues.set(key, preferences[key]);

export function readReceiptIsPrivate(): boolean {
  return !preferences.sendReadReceipts;
}

export function isExplicitPreference(key: keyof Preferences): boolean {
  return explicit.has(key) && !locked.has(key);
}

export function isLockedPreference(key: keyof Preferences): boolean {
  return locked.has(key);
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  if (locked.has(key)) return;
  preferences[key] = value;
  userValues.set(key, value);
  explicit.add(key);
  persist();
}

function assign<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  preferences[key] = value;
}

export function applyPreferences(
  next: Preferences,
  keys: readonly (keyof Preferences)[] = PREFERENCE_KEYS
): void {
  for (const key of keys) {
    if (locked.has(key)) continue;
    userValues.set(key, next[key]);
    explicit.add(key);
  }
  resolvePolicy();
  persist();
}

const UNSET = Object.fromEntries(
  PREFERENCE_KEYS.map((key) => [key, undefined])
) as unknown as Preferences;

function validPolicy(raw: Record<string, unknown>): Partial<Preferences> {
  return Object.fromEntries(
    Object.entries(sanitize(raw, UNSET)).filter(([key, value]) => key in raw && value !== undefined)
  );
}

export function applyDeploymentDefaults(raw: Record<string, unknown>): void {
  deploymentDefaults = validPolicy(raw);
  resolvePolicy();
}

export function applyDeploymentLocks(raw: Record<string, unknown>): void {
  deploymentLocks = validPolicy(raw);
  resolvePolicy();
}

// Keep remote settings out of stored user preferences.
export function applyAccountPreferences(
  defaults: Record<string, unknown>,
  locks: Record<string, unknown>
): void {
  const supported = (raw: Record<string, unknown>) =>
    validPolicy(
      Object.fromEntries(
        ACCOUNT_PREFERENCES.filter((key) => key in raw).map((key) => [key, raw[key]])
      )
    );
  accountDefaults = supported(defaults);
  const nextLocks = supported(locks);
  if (nextLocks.sendReadReceipts === false) nextLocks.hideReadReceipts = true;
  accountLocks = nextLocks;
  resolvePolicy();
}

export function accountDisablesReadReceipts(): boolean {
  return accountLocks.sendReadReceipts === false && !preferences.sendReadReceipts;
}

function resolvePolicy(): void {
  for (const key of PREFERENCE_KEYS) {
    const value = deploymentLocks[key] ?? accountLocks[key];
    if (value !== undefined) locked.add(key);
    else locked.delete(key);
    assign(
      key,
      (value ??
        userValues.get(key) ??
        accountDefaults[key] ??
        deploymentDefaults[key] ??
        DEFAULTS[key]) as Preferences[typeof key]
    );
  }
}

function persist(): void {
  untrack(() => {
    const stored: Record<string, unknown> = { schema: SETTINGS_SCHEMA };
    for (const key of explicit) {
      stored[key] = userValues.get(key);
    }
    writeJson(STORAGE_KEY, stored, '[sable settings] preferences not persisted');
  });
}
