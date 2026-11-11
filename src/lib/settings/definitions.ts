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
import { isNightlyBuild } from '#lib/platform/build-channel.js';
import { customTitleBarDefault } from '#lib/platform/window-decorations.js';
import type { BadgeNotificationMode } from '#lib/rooms/unread.js';

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

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const COMPOSER_ORDER_VALUES = [
  ...COMPOSER_ACTIONS,
  ...Array.from({ length: COMPOSER_SEPARATOR_MAX }, (_, index) => composerSeparatorId(index)),
];

interface Scope {
  /** A homeserver may default or lock it from `/.well-known/sable`. Any homeserver
      can set these, keep endpoints, telemetry and E2EE settings out. */
  account?: true;
  /** Stays on this device, settings sync leaves it alone. */
  device?: true;
  perAccount?: true;
}

const toggle = (value: boolean, scope: Scope = {}) => ({
  type: 'boolean' as const,
  default: value,
  ...scope,
});

const text = (value: string, scope: Scope = {}) => ({
  type: 'text' as const,
  default: value,
  ...scope,
});

const range = (min: number, max: number, value: number, scope: Scope = {}) => ({
  type: 'number' as const,
  min,
  max,
  default: value,
  ...scope,
});

const choice = <T extends string>(values: readonly T[], value: NoInfer<T>, scope: Scope = {}) => ({
  type: 'enum' as const,
  values: values as readonly string[],
  default: value,
  ...scope,
});

const list = <T extends string>(values: readonly string[], value: T[], scope: Scope = {}) => ({
  type: 'list' as const,
  values,
  default: value,
  ...scope,
});

const SETTINGS = {
  language: choice(languageValues, SYSTEM_LANGUAGE, { account: true }),
  layout: choice<TimelineLayout>(['modern', 'compact', 'bubble'], 'modern', {
    account: true,
    device: true,
  }),
  threadPresentation: choice<ThreadPresentation>(['timeline', 'panel'], 'timeline', {
    account: true,
    device: true,
  }),
  alignOwnMessages: toggle(true, { account: true }),
  avatarsInMessageHeaders: toggle(true, { account: true }),
  messageSpacing: choice<MessageSpacing>(['none', 'compact', 'cozy', 'roomy'], 'cozy', {
    account: true,
    device: true,
  }),
  timelineEmoteSize: choice<TimelineEmoteSize>(
    ['default', '20', '24', '32', '48', '64'],
    'default',
    { account: true }
  ),
  theme: choice<ThemeMode>(['system', 'dark', 'light'], 'system', { account: true }),
  quickCss: text(''),
  fontFamily: text('', { account: true, device: true }),
  fontFamilyMono: text('', { account: true, device: true }),
  codeLigatures: toggle(true, { account: true }),
  underlineLinks: toggle(true, { account: true }),
  renderRoomColors: toggle(true, { account: true }),
  renderProfileColors: toggle(true, { account: true }),
  reducedMotion: toggle(prefersReducedMotion(), { account: true, device: true }),
  pageZoom: range(0.75, 1.5, 1, { account: true, device: true }),
  textScale: range(0.75, 1.5, 1, { account: true, device: true }),
  highContrast: toggle(false, { account: true }),
  alwaysShowAltText: toggle(false, { account: true }),
  twitterEmoji: toggle(true, { account: true }),
  pixelatedImages: choice<PixelatedImages>(['always', 'smart', 'never'], 'never', {
    account: true,
  }),
  nameColorCorrection: choice<NameColorCorrection>(['strong', 'weak', 'off'], 'strong', {
    account: true,
  }),
  showRoomIcon: choice<ShowRoomIcon>(['always', 'sometimes', 'collapsed', 'never'], 'always', {
    account: true,
  }),
  showRoomBanners: toggle(true, { account: true }),
  showDmTopics: toggle(true, { account: true }),
  roomBannerHeight: range(56, 500, 190, { account: true, device: true }),
  subspaceHierarchyLimit: choice(SUBSPACE_DEPTHS, '3', { account: true }),
  searchIndexLimit: choice(SEARCH_INDEX_LIMITS, '512', { device: true }),
  coreLogLevel: choice(CORE_LOG_LEVELS, 'default', { device: true }),
  searchCrawlPause: choice(SEARCH_CRAWL_PAUSES, '3'),
  searchTricklePause: choice(SEARCH_TRICKLE_PAUSES, '10'),
  searchFlushInterval: choice(SEARCH_FLUSH_INTERVALS, '60'),
  searchBatchSize: choice(SEARCH_BATCH_SIZES, '50'),
  searchBaseEvents: choice(SEARCH_BASE_EVENTS, '20000'),
  searchMaxEvents: choice(SEARCH_MAX_EVENTS, '50000'),
  searchCrawler: toggle(true),
  searchUnmeteredOnly: toggle(true, { device: true }),
  searchSharing: toggle(true, { device: true }),
  serverSearch: toggle(true, { perAccount: true }),
  showHome: toggle(false, { account: true }),
  restoreLastRoom: toggle(true, { account: true }),
  showSearch: toggle(false, { account: true }),
  showUnreadCounts: toggle(false, { account: true }),
  badgeCountDMsOnly: toggle(true, { account: true }),
  showEasterEggs: toggle(true, { account: true }),
  showPingCounts: toggle(true, { account: true }),
  showUnreadDots: toggle(true, { account: true }),
  uniformIcons: toggle(false, { account: true }),
  tintRoomIcons: toggle(false, { account: true }),
  showBridgeBadges: toggle(true, { account: true }),
  showSpaceEvents: toggle(true, { account: true }),

  hour24Clock: toggle(false, { account: true }),
  dateFormat: choice<DateFormat>(['auto', 'dmy', 'mdy', 'ymd'], 'auto', { account: true }),
  timeZone: choice(timeZoneValues(), SYSTEM_TIME_ZONE, { account: true, device: true }),
  weekStart: choice<WeekStart>(['sunday', 'monday', 'saturday'], 'sunday', { account: true }),

  hideMembershipEvents: toggle(false, { account: true }),
  hideProfileChanges: toggle(true, { account: true }),
  hideTopicChanges: toggle(false, { account: true }),
  hideMemberInReadOnly: toggle(true, { account: true }),
  showTombstoneEvents: toggle(true, { account: true }),
  openRoomsAtUnread: toggle(true, { account: true }),
  jumpToLatestOnSend: toggle(false, { account: true }),
  hideReadReceipts: toggle(false, { account: true }),
  readReceiptPlacement: choice<ReadReceiptPlacement>(['message', 'room'], 'message', {
    account: true,
  }),
  replyPreviewStyle: choice<ReplyPreviewStyle>(['connected', 'compact', 'expanded'], 'connected', {
    account: true,
  }),
  captionPosition: choice<CaptionPosition>(['above', 'below', 'inline', 'hidden'], 'below', {
    account: true,
  }),
  usernameClick: choice<UsernameClick>(['mention', 'profile'], 'mention', { account: true }),
  doubleTapReact: toggle(true, { account: true }),
  messageSwipeAction: choice(['reply', 'members'], 'reply', { account: true }),
  showSingleReactionCount: toggle(true, { account: true }),
  showAllTimestamps: toggle(false, { account: true }),
  showRoleTooltip: toggle(false, { account: true }),
  hideMessageShields: toggle(false, { account: true }),
  doubleTapReaction: text('❤️', { account: true }),
  hideTypingIndicators: toggle(false, { account: true }),
  memberSort: choice<MemberSort>(['name-asc', 'name-desc', 'newest', 'oldest'], 'name-asc', {
    account: true,
  }),
  roomSort: choice<RoomSort>(['recent', 'name-asc', 'name-desc'], 'recent', { account: true }),
  directSort: choice<RoomSort>(['recent', 'name-asc', 'name-desc'], 'recent', { account: true }),
  groupMembersByPresence: toggle(true, { account: true }),
  filterPronounsByLanguage: toggle(true, { account: true }),
  showPronouns: toggle(true, { account: true }),
  showPronounPills: toggle(true, { account: true }),
  pronounPillLimit: choice<PronounPillLimit>(['1', '2', '3', 'all'], '3', { account: true }),
  pronounPillLength: choice<PronounPillLength>(['12', '16', '24', 'all'], 'all', { account: true }),

  composerForm: choice<ComposerForm>(['short', 'adaptive', 'tall'], 'tall', { account: true }),
  alwaysInlineEditor: toggle(false, { account: true }),
  enterForNewline: choice<EnterKey>(['adaptive', 'newline', 'send'], 'adaptive', {
    account: true,
    device: true,
  }),
  sedEdits: toggle(false, { account: true }),
  inlineEditing: toggle(false, { account: true }),
  mentionInReplies: toggle(true, { account: true }),
  formattingToolbar: toggle(false, { account: true }),
  composerFormatButton: toggle(true, { account: true }),
  richTextComposer: toggle(false, { account: true }),
  composerSpellcheck: toggle(true, { account: true, device: true }),
  composerAutocapitalize: toggle(true, { account: true, device: true }),
  emoticonToEmoji: toggle(false, { account: true }),
  composerGifButton: toggle(true, { account: true }),
  composerStickerButton: toggle(true, { account: true }),
  composerEmoteButton: toggle(true, { account: true }),
  composerVoiceButton: toggle(true, { account: true }),
  composerButtonOrder: list<ComposerButton>(COMPOSER_ORDER_VALUES, [...COMPOSER_BUTTONS], {
    account: true,
  }),
  scheduleInEncryptedRooms: toggle(true),
  sendAttachmentAsCaption: toggle(true, { account: true }),
  sendAttachmentsAsGallery: toggle(false, { account: true }),
  imageMetadata: choice<ImageMetadata>(['location', 'all', 'keep'], 'location'),

  personaPicker: toggle(true, { account: true }),
  personaPickerSortOrder: choice<PersonaPickerSortOrder>(
    ['manual', 'alphabetical-asc', 'alphabetical-desc', 'recent'],
    'recent',
    { account: true }
  ),
  personaPickerLeftSide: toggle(false, { account: true }),
  personaPickerShowAccountWhenDeselected: toggle(true, { account: true }),
  personaProxying: toggle(false, { account: true }),
  personaSelectionScope: choice<PersonaSelectionScope>(
    ['account', 'space', 'room', 'picker'],
    'picker',
    { account: true }
  ),
  personaKeepAfterShorthand: toggle(false, { account: true }),
  personaFallback: toggle(true, { account: true }),
  personaGrid: toggle(true, { account: true }),
  personaAlternateAvatar: toggle(false, { account: true }),

  sendTypingNotifications: toggle(true, { account: true, perAccount: true }),
  sendReadReceipts: toggle(true, { account: true, perAccount: true }),
  sendPresence: toggle(true, { account: true, perAccount: true }),
  blurMedia: toggle(false, { account: true }),
  blurAvatars: toggle(false, { account: true }),
  blurEmotes: toggle(false, { account: true }),
  presence: choice<PresenceView>(['online', 'unavailable', 'busy', 'offline'], 'online', {
    perAccount: true,
  }),
  presenceStatusMessage: text('', { perAccount: true }),
  loadingAnimal: text('', { account: true }),

  mediaAutoLoad: choice<MediaAutoLoad>(['on', 'private', 'off'], 'on', {
    account: true,
    device: true,
  }),
  autoplayGifs: toggle(true, { account: true }),
  pauseAnimationsWhenInactive: toggle(false, { account: true }),
  autoplayStickers: toggle(true, { account: true }),
  gifProvider: choice<GifProviderSetting>(['default', 'klipy', 'tenor', 'giphy'], 'default'),
  urlPreviews: toggle(false, { account: true, perAccount: true }),
  themeFileCards: toggle(true, { account: true }),
  encryptedUrlPreviews: toggle(false, { perAccount: true }),
  clientEmbeds: toggle(false),
  encryptedClientEmbeds: toggle(false),
  youtubeEmbeds: toggle(false),
  useDearrow: toggle(false),
  dearrowThumbnailFallback: choice(DEARROW_THUMBNAIL_FALLBACKS, 'youtube_autogen'),
  youtubeThumbnailPosition: choice(YOUTUBE_THUMBNAIL_POSITIONS, 'middle'),
  tiktokEmbeds: toggle(false),
  instagramEmbeds: toggle(false),

  systemNotifications: toggle(true, { device: true }),
  badgeDefaultDirect: choice<BadgeNotificationMode>(['all', 'mentions', 'quiet'], 'all', {
    account: true,
  }),
  badgeDefaultGroup: choice<BadgeNotificationMode>(['all', 'mentions', 'quiet'], 'mentions', {
    account: true,
  }),
  notificationSounds: toggle(true, { device: true }),
  notifyOnce: toggle(true, { account: true }),
  pushInactiveTimeout: choice(PUSH_INACTIVE_TIMEOUTS, '1'),
  backgroundNotificationSounds: toggle(true, { device: true }),
  notificationContent: toggle(false, { device: true }),
  notificationEncryptedContent: toggle(false, { device: true }),
  richPushPayloads: toggle(true, { device: true }),
  clearNotificationsOnRead: toggle(true),
  highlightMentions: toggle(true, { account: true }),
  faviconForMentionsOnly: toggle(false, { account: true }),
  ringForGroupCalls: toggle(false, { account: true }),
  alwaysShowCallButton: toggle(false, { account: true }),
  callScreenPreview: toggle(true, { account: true }),
  callMode: choice(CALL_MODES, 'auto'),
  callServiceUrl: text(''),
  incomingCallSound: toggle(true, { account: true }),
  outgoingRingback: toggle(true, { account: true }),
  callMicrophoneMuted: toggle(false, { device: true }),
  callInputMode: choice(CALL_INPUT_MODES, 'voice-activity'),
  callGlobalShortcuts: toggle(true),
  noiseSuppression: toggle(true, { device: true }),
  voiceIsolation: toggle(false, { device: true }),
  incomingVoiceIsolation: toggle(false, { device: true }),
  echoCancellation: toggle(true, { device: true }),
  autoGainControl: toggle(true, { device: true }),
  audioInputDevice: text('', { device: true }),
  audioOutputDevice: text('', { device: true }),
  videoInputDevice: text('', { device: true }),
  callCameraResolution: choice(CALL_VIDEO_RESOLUTIONS, 'auto'),
  callCameraBitrate: choice(CALL_VIDEO_BITRATES, 'auto'),
  callCameraCodec: choice(CALL_VIDEO_CODECS, 'auto'),
  callScreenResolution: choice(CALL_VIDEO_RESOLUTIONS, '720'),
  callScreenBitrate: choice(CALL_VIDEO_BITRATES, 'auto'),
  callScreenFramerate: choice(CALL_SCREEN_FRAMERATES, '30'),
  callScreenCodec: choice(CALL_VIDEO_CODECS, 'h264'),
  callSimulcast: toggle(true),

  /** Empty falls back to `config.json`; see `hasCompleteOverride`. */
  pushGatewayUrl: text('', { device: true }),
  pushVapidKey: text('', { device: true }),
  pushAppId: text('', { device: true }),
  /** Empty falls back to `unifiedPushEmbeddedServerUrl` in `config.json`. */
  pushEmbeddedServerUrl: text('', { device: true }),

  soundsNotificationVolume: range(0, 2.0, 1, { device: true }),
  soundsCameraOnVolume: range(0, 2.0, 1, { device: true }),
  soundsCameraOffVolume: range(0, 2.0, 1, { device: true }),
  soundsMicOnVolume: range(0, 2.0, 1, { device: true }),
  soundsMicOffVolume: range(0, 2.0, 1, { device: true }),
  soundsDeafenOnVolume: range(0, 2.0, 1, { device: true }),
  soundsDeafenOffVolume: range(0, 2.0, 1, { device: true }),
  soundsScreenshareStartVolume: range(0, 2.0, 1, { device: true }),
  soundsScreenshareStopVolume: range(0, 2.0, 1, { device: true }),
  soundsCallJoinVolume: range(0, 2.0, 1, { device: true }),
  soundsCallLeaveVolume: range(0, 2.0, 1, { device: true }),
  soundsIncomingCallVolume: range(0, 2.0, 1, { device: true }),
  soundsOutgoingCallVolume: range(0, 2.0, 1, { device: true }),

  errorReporting: toggle(false, { device: true }),
  sessionReplay: toggle(false, { device: true }),
  /** Distinguishes a declined prompt from one that was never shown. */
  telemetryAsked: toggle(false, { device: true }),

  autoUpdateCheck: toggle(true, { device: true }),
  updateChannel: choice(UPDATE_CHANNELS, isNightlyBuild() ? 'nightly' : 'stable', { device: true }),
  closeToTray: toggle(false, { device: true }),
  askDownloadLocation: toggle(true, { device: true }),
  minimizeToTray: toggle(false, { device: true }),
  showSystemTrayIcon: toggle(true, { device: true }),
  useCustomTitleBar: toggle(customTitleBarDefault(), { device: true }),
  hardwareAcceleration: toggle(true, { device: true }),
  hardwareVideoEncode: toggle(true, { device: true }),
  hardwareVideoDecode: toggle(true, { device: true }),
  smoothScrolling: toggle(true, { device: true }),
  webRtcIpPolicy: choice(WEBRTC_IP_POLICIES, 'default', { device: true }),
  launchAtLogin: toggle(false, { device: true }),
  startMinimized: toggle(false, { device: true }),

  settingsSync: toggle(false, { device: true }),
  syncDrafts: toggle(true, { device: true }),
  profileChangePropagation: choice<ProfilePropagationView>(
    ['all', 'unchanged', 'none'],
    'unchanged',
    { account: true }
  ),

  developerTools: toggle(false, { device: true }),
  callStatsOverlay: toggle(false),
  callDebugOverlay: toggle(true),
  showHiddenEvents: toggle(false),
  hiddenEventsHeaderToggle: toggle(false),
  hiddenEventEdits: toggle(true),
  hiddenEventReactions: toggle(true),
  hiddenEventRedactions: toggle(true),
  hiddenEventOther: toggle(true),
  showTranslationStrings: toggle(false),
};

export type Preferences = { [K in keyof typeof SETTINGS]: (typeof SETTINGS)[K]['default'] };

type PreferenceOfType<T extends string> = {
  [K in keyof Preferences]: (typeof SETTINGS)[K] extends { type: T } ? K : never;
}[keyof Preferences];

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

export const PREFERENCE_KEYS = Object.keys(SETTINGS) as (keyof Preferences)[];

export type FreeTextPreference = PreferenceOfType<'text'>;
export type RangePreference = PreferenceOfType<'number'>;

export const DEFAULTS = Object.fromEntries(
  PREFERENCE_KEYS.map((key) => [key, SETTINGS[key].default])
) as Preferences;

export const PREFERENCE_RANGES = Object.fromEntries(
  PREFERENCE_KEYS.flatMap((key) => {
    const setting = SETTINGS[key];
    return setting.type === 'number' ? [[key, { min: setting.min, max: setting.max }]] : [];
  })
) as Record<RangePreference, { min: number; max: number }>;

export const ACCOUNT_PREFERENCES = PREFERENCE_KEYS.filter((key) => SETTINGS[key].account);
export const PER_ACCOUNT_PREFERENCES: ReadonlySet<keyof Preferences> = new Set(
  PREFERENCE_KEYS.filter((key) => SETTINGS[key].perAccount)
);
export const NON_SYNCABLE_KEYS: ReadonlySet<keyof Preferences> = new Set(
  PREFERENCE_KEYS.filter((key) => SETTINGS[key].device)
);

export type PreferenceSpec = { key: keyof Preferences } & (typeof SETTINGS)[keyof Preferences];

export function preferenceSpecs(): PreferenceSpec[] {
  return PREFERENCE_KEYS.map((key) => ({ key, ...SETTINGS[key] }));
}

function legacyEnterKey(value: unknown): unknown {
  return typeof value === 'boolean' ? (value ? 'newline' : 'adaptive') : value;
}

export function sanitize(stored: Record<string, unknown>, base: Preferences): Preferences {
  const next: Record<string, unknown> = { ...base };
  for (const key of PREFERENCE_KEYS) {
    let value = key === 'enterForNewline' ? legacyEnterKey(stored[key]) : stored[key];
    if (key === 'mediaAutoLoad' && typeof value === 'boolean') value = value ? 'on' : 'off';
    if (key === 'callMode' && value === undefined && stored.forceLegacyCalls === true) {
      value = 'legacy';
    }
    const setting = SETTINGS[key];
    switch (setting.type) {
      case 'enum':
        if (typeof value === 'string' && setting.values.includes(value)) next[key] = value;
        break;
      case 'list':
        if (Array.isArray(value)) next[key] = normalizeComposerOrder(value);
        break;
      case 'number':
        if (typeof value === 'number' && Number.isFinite(value))
          next[key] = Math.min(setting.max, Math.max(setting.min, value));
        break;
      case 'text':
        if (typeof value === 'string') next[key] = value;
        break;
      case 'boolean':
        if (typeof value === 'boolean') next[key] = value;
    }
  }
  return next as Preferences;
}
