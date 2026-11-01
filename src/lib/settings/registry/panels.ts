import { hasNativeCalls } from '#lib/platform/calls.js';
import { isAndroid, isNativeMobile } from '#lib/platform/os.js';
import { preferences } from '../preferences.svelte';
import type { SettingsTargetDefinition } from '../registry';

type PanelTarget = Omit<SettingsTargetDefinition, 'icon'>;
type TargetRow = readonly [focusId: string, name: string, description?: string];

function targets(
  rows: readonly TargetRow[],
  options: Pick<PanelTarget, 'supported' | 'terms'> = {}
): PanelTarget[] {
  return rows.map(([focusId, name, description]) => ({
    key: focusId,
    focusId,
    name,
    description,
    ...options,
  }));
}

const developerTools = () => preferences.developerTools;

// Chat link labels use this module too; keep UI imports out.
export const panelTargets: Record<string, PanelTarget[]> = {
  appearance: [
    ...targets([
      ['themes', 'settings.groups.themes', 'settings.customThemesSlotsHint'],
      ['quick-css', 'settings.quickCss', 'settings.quickCssHint'],
      ['font-family', 'settings.fontFamily', 'settings.fontFamilyHint'],
      ['font-family-mono', 'settings.fontFamilyMono', 'settings.fontFamilyMonoHint'],
      ['code-ligatures', 'settings.codeLigatures', 'settings.codeLigaturesHint'],
    ]),
    ...targets([['app-icon', 'settings.appIconTitle']], { supported: isNativeMobile }),
  ],
  composer: targets([['composer-separator-count', 'settings.composerSeparatorCount']]),
  notifications: [
    ...targets([
      ['notification-badges', 'settings.notificationBadges', 'settings.notificationBadgesHint'],
      ['notification-push', 'settings.notificationPush', 'settings.notificationPushHint'],
      [
        'notification-master-mute',
        'settings.notificationMasterMute',
        'settings.notificationMasterMuteHint',
      ],
      ['notification-event-membership', 'settings.notificationMembership'],
      ['notification-event-reactions', 'settings.notificationReactions'],
      ['notification-event-edits', 'settings.notificationEdits'],
      ['notification-event-notices', 'settings.notificationNotices'],
      ['notification-event-invites', 'settings.notificationInvites'],
      ['notification-event-calls', 'settings.notificationCalls'],
      ['mention-notifications', 'settings.mentions', 'settings.mentionsHint'],
      ['mention-user', 'settings.matrixId'],
      ['mention-display_name', 'common.displayName'],
      ['mention-username', 'auth.username'],
      ['mention-room', 'settings.mentionsRoom', 'settings.mentionsRoomHint'],
      [
        'notification-keywords',
        'settings.notificationKeywords',
        'settings.notificationKeywordsHint',
      ],
      ['pushers-heading', 'settings.pushers'],
      ['notification-troubleshoot', 'settings.troubleshootTitle', 'settings.troubleshootHint'],
    ]),
    ...targets(
      [
        ['notification-badge-badgeDefaultDirect', 'common.directMessages'],
        ['notification-badge-badgeDefaultGroup', 'settings.notificationDefaultGroup'],
      ],
      { terms: ['settings.notificationBadges'] }
    ),
    ...targets(
      [
        ['notification-push-direct', 'common.directMessages'],
        ['notification-push-group', 'settings.notificationDefaultGroup'],
      ],
      { terms: ['settings.notificationPush'] }
    ),
    ...targets([['push-gateway', 'settings.pushGateway', 'settings.pushGatewayHint']]),
    ...targets([['push-distributor', 'settings.pushTransport', 'settings.pushTransportHint']], {
      supported: isAndroid,
    }),
  ],
  calls: [
    ...targets(
      [
        ['call-devices', 'settings.callDevicesTitle'],
        ['call-input-device', 'settings.callInputDevice'],
        ['call-output-device', 'settings.callOutputDevice'],
        ['call-camera-device', 'settings.callCameraDevice'],
        ['call-output-volume', 'settings.callOutputVolume'],
        ['call-mic-test', 'settings.callMicTestLevel'],
      ],
      { supported: () => !hasNativeCalls() }
    ),
    ...targets([
      ['call-compat', 'settings.groups.callCompat'],
      ['call-compat-sticky', 'settings.callCompatSticky'],
      ['call-compat-delayed', 'settings.callCompatDelayed'],
      ['call-compat-transports', 'settings.callCompatTransports'],
    ]),
  ],
  sounds: targets([
    ['sound-volume-notification', 'sounds.notification'],
    ['sound-volume-camera_on', 'sounds.camera_on'],
    ['sound-volume-camera_off', 'sounds.camera_off'],
    ['sound-volume-mic_on', 'sounds.mic_on'],
    ['sound-volume-mic_off', 'sounds.mic_off'],
    ['sound-volume-deafen_on', 'sounds.deafen_on'],
    ['sound-volume-deafen_off', 'sounds.deafen_off'],
    ['sound-volume-screenshare_start', 'sounds.screenshare_start'],
    ['sound-volume-screenshare_stop', 'sounds.screenshare_stop'],
    ['sound-volume-call_join', 'sounds.call_join'],
    ['sound-volume-call_leave', 'sounds.call_leave'],
    ['sound-volume-incoming_call', 'sounds.incoming_call'],
    ['sound-volume-outgoing_call', 'sounds.outgoing_call'],
  ]),
  privacy: targets([['invite-avatars', 'settings.inviteAvatars']]),
  personas: targets([
    ['settings-personas', 'personas.manageTitle', 'personas.manageDescription'],
    ['settings-personas-pluralkit', 'personas.importTitle', 'personas.importDescription'],
    ['settings-personas-backup', 'personas.backupTitle', 'personas.backupDescription'],
  ]),
  account: [
    ...targets([
      ['account-profile', 'settings.profile'],
      ['account-contact', 'settings.contactInformation'],
      ['account-blocked', 'settings.blockedUsers'],
      ['account-devices', 'settings.signedInDevices'],
      ['link-device', 'qrLogin.titleGrant', 'qrLogin.linkDeviceHint'],
      ['settings-file', 'settings.settingsFileTitle', 'settings.settingsFileHint'],
    ]),
    ...targets([['sync-status', 'settings.syncStatusTitle']], {
      supported: () => preferences.settingsSync,
    }),
    ...targets([['sync-encryption', 'settings.syncEncryptionTitle']], {
      supported: () => preferences.settingsSync && preferences.syncDrafts,
    }),
  ],
  devices: [
    ...targets(
      [['encryption-heading', 'settings.encryption', 'settings.setUpRecoveryDescription']],
      {
        terms: [
          'settings.verifyDevice',
          'settings.resetRecoveryKey',
          'common.setUpRecovery',
          'settings.resetIdentity',
          'settings.resetIdentityDescription',
        ],
      }
    ),
    ...targets([
      ['key-backup-heading', 'settings.keyBackupTitle'],
      ['devices-heading', 'settings.signedInDevices'],
      ['room-keys-heading', 'settings.roomKeys'],
      ['room-keys-export', 'settings.roomKeysExport', 'settings.roomKeysExportDescription'],
      ['room-keys-import', 'settings.roomKeysImport', 'settings.roomKeysImportDescription'],
    ]),
  ],
  timeline: targets(
    [
      ['developer-search-metrics', 'settings.developerSearchTitle'],
      ['search-phase', 'settings.developerSearchPhase'],
      ['search-documents', 'settings.developerSearchDocuments'],
      ['search-loaded', 'settings.developerSearchLoaded'],
      ['search-memory', 'settings.developerSearchMemory'],
      ['search-disk', 'settings.developerSearchDisk'],
      ['search-events', 'settings.developerSearchEvents'],
      ['search-rate', 'settings.developerSearchRate'],
      ['search-running', 'settings.developerSearchRunning'],
      ['search-batches', 'settings.developerSearchBatches'],
      ['search-pushbacks', 'settings.developerSearchPushbacks'],
      ['search-request-last', 'settings.developerSearchRequestLast'],
      ['search-request-average', 'settings.developerSearchRequestAverage'],
      ['search-rooms-indexed', 'settings.developerSearchRoomsIndexed'],
      ['search-rooms-pending', 'settings.developerSearchRoomsPending'],
      ['search-rooms-exhausted', 'settings.developerSearchRoomsExhausted'],
      ['search-rooms-failed', 'settings.developerSearchRoomsFailed'],
      ['search-rooms-blind', 'settings.developerSearchRoomsBlind'],
      ['search-rooms-unreadable', 'settings.developerSearchRoomsUnreadable'],
    ],
    { supported: developerTools }
  ),
  developer: targets(
    [
      ['developer-sync-diagnostics', 'settings.developerSyncTitle'],
      ['developer-server-features', 'settings.developerServerFeaturesTitle'],
      ['developer-account-data', 'settings.developerAccountDataTitle'],
      ['developer-push-rules', 'settings.developerPushRulesTitle'],
      ['developer-notifications', 'settings.developerNotificationsTitle'],
      ['developer-debug-logs', 'settings.developerLogsTitle'],
      ['developer-sentry', 'settings.developerSentryTitle'],
      ['settings-state-event', 'settings.stateEventTitle'],
      ['access-token', 'settings.developerAccessTokenTitle'],
      ['account-data-add', 'settings.developerAccountDataAdd'],
      ['debug-logs-status', 'settings.developerLogsStatus'],
      ['send-test-notification', 'settings.developerNotificationsTitle'],
      ['push-outcomes', 'settings.developerPushOutcomesTitle'],
      ['push-history', 'settings.developerPushHistoryTitle'],
      ['sentry-configured', 'settings.developerSentryConfigured'],
      ['sentry-environment', 'settings.developerSentryEnvironment'],
      ['sentry-reporting', 'settings.developerSentryReporting'],
      ['sentry-replay', 'settings.developerSentryReplay'],
      ['sentry-activity', 'settings.developerSentryActivity'],
      ['sync-state', 'settings.developerSyncState'],
      ['sync-core-status', 'settings.developerSyncCoreStatus'],
      ['sync-rooms', 'settings.developerSyncRooms'],
      ['sync-account', 'settings.developerSyncAccount'],
      ['sync-revision', 'settings.developerSyncRevision'],
      ['sync-unresponsive', 'settings.developerSyncUnresponsive'],
      ['server-feature-org.matrix.simplified_msc3575', 'settings.serverFeatureSlidingSync'],
      ['server-feature-org.matrix.msc4140', 'settings.callCompatDelayed'],
      ['server-feature-org.matrix.msc4354', 'settings.callCompatSticky'],
      ['server-feature-computer.gingershaped.msc4466', 'settings.serverFeatureProfilePropagation'],
    ],
    { supported: developerTools }
  ),
};
