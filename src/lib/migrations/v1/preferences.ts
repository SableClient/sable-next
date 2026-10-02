import { readJson } from '#lib/platform/local-json.js';
import { V1_MIGRATION_ENABLED } from './config.js';
import type { Preferences } from '#lib/settings/preferences.svelte.js';

const SHARED = [
  'twitterEmoji',
  'uniformIcons',
  'enterForNewline',
  'gifProvider',
  'hideMembershipEvents',
  'showHiddenEvents',
  'showTombstoneEvents',
  'hiddenEventEdits',
  'hiddenEventReactions',
  'hiddenEventOther',
  'mediaAutoLoad',
  'backgroundNotificationSounds',
  'clearNotificationsOnRead',
  'hour24Clock',
  'developerTools',
  'showPronouns',
  'renderRoomColors',
  'captionPosition',
  'sendPresence',
  'showUnreadCounts',
  'badgeCountDMsOnly',
  'showPingCounts',
  'alwaysShowCallButton',
  'faviconForMentionsOnly',
  'highlightMentions',
  'mentionInReplies',
  'profileChangePropagation',
  'showRoomBanners',
  'roomBannerHeight',
  'underlineLinks',
  'reducedMotion',
  'autoplayGifs',
  'autoplayStickers',
] as const satisfies readonly (keyof Preferences)[];

const RENAMED = {
  hideNickAvatarEvents: 'hideProfileChanges',
  hideMembershipInReadOnly: 'hideMemberInReadOnly',
  hideReads: 'hideReadReceipts',
  useRightBubbles: 'alignOwnMessages',
  editorToolbar: 'formattingToolbar',
  editorEmojiButton: 'composerEmoteButton',
  editorGifButton: 'composerGifButton',
  editorStickerButton: 'composerStickerButton',
  editorButtonOrder: 'composerButtonOrder',
  urlPreview: 'urlPreviews',
  encUrlPreview: 'encryptedUrlPreviews',
  clientUrlPreview: 'clientEmbeds',
  encClientUrlPreview: 'encryptedClientEmbeds',
  clientPreviewYoutube: 'youtubeEmbeds',
  useSystemNotifications: 'systemNotifications',
  isNotificationSounds: 'notificationSounds',
  showMessageContentInNotifications: 'notificationContent',
  showMessageContentInEncryptedNotifications: 'notificationEncryptedContent',
  useRichPushPayloads: 'richPushPayloads',
  settingsSyncEnabled: 'settingsSync',
  privacyBlur: 'blurMedia',
  privacyBlurAvatars: 'blurAvatars',
  privacyBlurEmotes: 'blurEmotes',
  pixelatedImageRendering: 'pixelatedImages',
  nameColorLightnessCorrection: 'nameColorCorrection',
  incomingCallSoundEnabled: 'incomingCallSound',
  outgoingRingbackEnabled: 'outgoingRingback',
  pmpPicker: 'personaPicker',
  pmpProxying: 'personaProxying',
  sendIndividualAttachmentAsCaption: 'sendAttachmentAsCaption',
  hiddenEventRedactionTimeline: 'hiddenEventRedactions',
} as const satisfies Record<string, keyof Preferences>;

export function convertV1Preferences(source: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const key of SHARED) if (key in source) next[key] = source[key];
  for (const [old, key] of Object.entries(RENAMED)) if (old in source) next[key] = source[old];
  if (typeof source.pageZoom === 'number') next.pageZoom = source.pageZoom / 100;
  if (typeof source.messageLayout === 'number')
    next.layout = ['modern', 'compact', 'bubble'][source.messageLayout];
  if (
    typeof source.messageSpacing === 'string' &&
    ['0', '100', '200', '300', '400', '500'].includes(source.messageSpacing)
  ) {
    next.messageSpacing =
      Number(source.messageSpacing) <= 200
        ? 'compact'
        : source.messageSpacing === '500'
          ? 'roomy'
          : 'cozy';
  }
  if (source.useSystemTheme === true) next.theme = 'system';
  else if (source.themeId === 'dark-theme' || source.themeId === 'light-theme')
    next.theme = source.themeId === 'dark-theme' ? 'dark' : 'light';
  if (source.showRoomIcon === 'always' || source.showRoomIcon === 'never')
    next.showRoomIcon = source.showRoomIcon;
  else if (source.showRoomIcon === 'smart') next.showRoomIcon = 'sometimes';
  else if (source.showRoomIcon === 'strict') next.showRoomIcon = 'collapsed';
  if (typeof source.pmpLatching === 'boolean')
    next.personaLatching = source.pmpLatching ? 'room' : 'off';
  if (typeof source.pmpNoFallback === 'boolean') next.personaFallback = !source.pmpNoFallback;
  if (typeof source.filterPronounsBasedOnLanguage === 'boolean')
    next.filterPronounsByLanguage = source.filterPronounsBasedOnLanguage;
  if (typeof source.subspaceHierarchyLimit === 'number')
    next.subspaceHierarchyLimit = String(source.subspaceHierarchyLimit);
  if (typeof source.pronounPillMaxCount === 'number')
    next.pronounPillLimit = String(source.pronounPillMaxCount);
  if (typeof source.pronounPillMaxLength === 'number')
    next.pronounPillLength = String(source.pronounPillMaxLength);
  if (typeof source.callRingtoneVolume === 'number')
    next.callRingtoneVolume =
      source.callRingtoneVolume <= 30
        ? 'quiet'
        : source.callRingtoneVolume >= 90
          ? 'loud'
          : 'normal';
  if (Array.isArray(next.composerButtonOrder))
    next.composerButtonOrder = next.composerButtonOrder.map((button: unknown) =>
      button === 'emoji' ? 'emoticon' : button
    );
  return next;
}

export function convertV1SyncedSettings(content: unknown): unknown {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return null;
  const body = content as Record<string, unknown>;
  if (
    body.v !== 1 ||
    body.settings === null ||
    typeof body.settings !== 'object' ||
    Array.isArray(body.settings)
  )
    return null;
  return { v: 1, settings: convertV1Preferences(body.settings as Record<string, unknown>) };
}

export function readV1Preferences(): Record<string, unknown> | null {
  if (!V1_MIGRATION_ENABLED) return null;
  return readJson(
    'settings',
    (value) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
      return convertV1Preferences(value as Record<string, unknown>);
    },
    null
  );
}
