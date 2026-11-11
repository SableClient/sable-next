import { hasNativeCalls } from '#lib/platform/calls.js';
import { deliversDeepLinks } from '#lib/platform/deep-links.js';
import { isAndroid, isNativeMobile, supportsTouch } from '#lib/platform/os.js';
import { presenceSharing } from '#lib/rooms/presence-sharing.svelte.js';
import { preferences } from '../preferences.svelte';
import type { SettingsGate, SettingsTargetDefinition } from '../registry';

type PanelTarget = Omit<SettingsTargetDefinition, 'icon'>;
type TargetRow = readonly [focusId: string, name: string, description?: string];

export interface SettingsPanelDefinition {
  id: string;
  section?: string;
  start?: true;
  supported?: SettingsGate;
  targets?: PanelTarget[];
}

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

const handlesMatrixLinksInBrowser = () =>
  !deliversDeepLinks() && 'registerProtocolHandler' in navigator;
const developerTools = () => preferences.developerTools;
const settingsSync = () => preferences.settingsSync;

// Chat link labels use this module too; keep UI imports out.
export const settingsPanels: Record<string, SettingsPanelDefinition[]> = {
  appearance: [
    {
      id: 'custom-themes',
      section: 'themes',
      targets: targets([['themes', 'settings.groups.themes', 'settings.customThemesSlotsHint']]),
    },
    {
      id: 'quick-css',
      section: 'themes',
      targets: targets([['quick-css', 'settings.quickCss', 'settings.quickCssHint']]),
    },
    {
      id: 'app-icon',
      section: 'themes',
      supported: isNativeMobile,
      targets: targets([['app-icon', 'settings.appIconTitle']]),
    },
    {
      id: 'font',
      section: 'font',
      targets: targets([
        ['font-family', 'settings.fontFamily', 'settings.fontFamilyHint'],
        ['font-family-mono', 'settings.fontFamilyMono', 'settings.fontFamilyMonoHint'],
        ['code-ligatures', 'settings.codeLigatures', 'settings.codeLigaturesHint'],
      ]),
    },
  ],
  composer: [
    { id: 'composer-enter', section: 'writing', start: true },
    {
      id: 'composer-buttons',
      section: 'composer-buttons',
      targets: targets([['composer-separator-count', 'settings.composerSeparatorCount']]),
    },
  ],
  timeline: [
    { id: 'double-tap-reaction', section: 'messages', supported: supportsTouch },
    {
      id: 'matrix-link-handler',
      section: 'messages',
      supported: handlesMatrixLinksInBrowser,
      targets: targets([
        ['matrix-link-handler', 'settings.matrixLinkHandler', 'settings.matrixLinkHandlerHint'],
      ]),
    },
    {
      id: 'search-sharing-status',
      section: 'message-search',
      supported: () => preferences.searchSharing,
    },
    {
      id: 'developer-search-metrics',
      section: 'developer-search-metrics',
      supported: developerTools,
      targets: targets([
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
      ]),
    },
  ],
  notifications: [
    { id: 'notification-permission', section: 'alerts', start: true },
    {
      id: 'notification-defaults',
      targets: [
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
      ],
    },
    {
      id: 'mention-notifications',
      targets: targets([
        ['mention-notifications', 'settings.mentions', 'settings.mentionsHint'],
        ['mention-user', 'settings.matrixId'],
        ['mention-display_name', 'common.displayName'],
        ['mention-username', 'auth.username'],
        ['mention-room', 'settings.mentionsRoom', 'settings.mentionsRoomHint'],
      ]),
    },
    {
      id: 'notification-keywords',
      targets: targets([
        [
          'notification-keywords',
          'settings.notificationKeywords',
          'settings.notificationKeywordsHint',
        ],
      ]),
    },
    {
      id: 'notification-rooms',
      targets: targets([
        ['notification-rooms', 'settings.notificationRooms', 'settings.notificationRoomsHint'],
      ]),
    },
    { id: 'pushers', targets: targets([['pushers-heading', 'settings.pushers']]) },
    {
      id: 'push-gateway',
      targets: [
        ...targets([['push-gateway', 'settings.pushGateway', 'settings.pushGatewayHint']]),
        ...targets([['push-distributor', 'settings.pushTransport', 'settings.pushTransportHint']], {
          supported: isAndroid,
        }),
      ],
    },
    {
      id: 'notification-troubleshoot',
      targets: targets([
        ['notification-troubleshoot', 'settings.troubleshootTitle', 'settings.troubleshootHint'],
      ]),
    },
  ],
  calls: [
    {
      id: 'call-service',
      section: 'call-service',
      targets: targets([
        ['call-service-url', 'settings.callServiceUrl', 'settings.callServiceUrlHint'],
      ]),
    },
    {
      id: 'call-devices',
      section: 'call-devices',
      supported: () => !hasNativeCalls(),
      targets: targets([
        ['call-devices', 'settings.callDevicesTitle'],
        ['call-input-device', 'settings.callInputDevice'],
        ['call-output-device', 'settings.callOutputDevice'],
        ['call-camera-device', 'settings.callCameraDevice'],
        ['call-output-volume', 'settings.callOutputVolume'],
        ['call-mic-test', 'settings.callMicTestLevel'],
      ]),
    },
    {
      id: 'call-compat',
      section: 'call-compat',
      targets: targets([
        ['call-compat', 'settings.groups.callCompat'],
        ['call-compat-sticky', 'settings.callCompatSticky'],
        ['call-compat-delayed', 'settings.callCompatDelayed'],
        ['call-compat-transports', 'settings.callCompatTransports'],
      ]),
    },
  ],
  sounds: [
    {
      id: 'sound-volumes',
      section: 'volumes',
      targets: targets([
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
    },
  ],
  privacy: [
    {
      id: 'presence-sharing',
      section: 'online-status',
      supported: () => presenceSharing.supported,
      targets: targets([
        ['presence-share-locally', 'settings.presenceShareLocally', 'settings.presenceSharingHint'],
        ['presence-people', 'settings.presenceSharingUsers', 'settings.presenceSharingUsersHint'],
        ['presence-rooms', 'settings.presenceSharingRooms', 'settings.presenceSharingRoomsHint'],
        [
          'presence-servers',
          'settings.presenceSharingServers',
          'settings.presenceSharingServersHint',
        ],
      ]),
    },
    {
      id: 'media-preview-privacy',
      section: 'blurring',
      start: true,
      targets: targets([['invite-avatars', 'settings.inviteAvatars']]),
    },
  ],
  personas: [
    {
      id: 'personas',
      targets: targets([
        ['settings-personas', 'personas.manageTitle', 'personas.manageDescription'],
        ['settings-personas-pluralkit', 'personas.importTitle', 'personas.importDescription'],
        ['settings-personas-backup', 'personas.backupTitle', 'personas.backupDescription'],
      ]),
    },
  ],
  account: [
    {
      id: 'profile',
      targets: targets([
        ['account-profile', 'settings.profile'],
        ['account-contact', 'settings.contactInformation'],
        ['account-blocked', 'settings.blockedUsers'],
      ]),
    },
    {
      id: 'link-device',
      section: 'account-devices',
      supported: (context) => context.oauth,
      targets: targets([
        ['account-devices', 'settings.signedInDevices'],
        ['link-device', 'qrLogin.titleGrant', 'qrLogin.linkDeviceHint'],
      ]),
    },
    {
      id: 'settings-sync-status',
      section: 'sync',
      supported: settingsSync,
      targets: targets([['sync-status', 'settings.syncStatusTitle']]),
    },
    {
      id: 'sync-encryption',
      section: 'sync',
      supported: settingsSync,
      targets: targets([['sync-encryption', 'settings.syncEncryptionTitle']]),
    },
    {
      id: 'settings-file',
      section: 'sync',
      targets: targets([
        ['settings-file', 'settings.settingsFileTitle', 'settings.settingsFileHint'],
      ]),
    },
  ],
  devices: [
    {
      id: 'security',
      targets: [
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
          ['dehydrated-device', 'settings.dehydratedDevice', 'settings.dehydratedDeviceHint'],
          ['key-backup-heading', 'settings.keyBackupTitle'],
          ['devices-heading', 'settings.signedInDevices'],
          ['room-keys-heading', 'settings.roomKeys'],
          ['room-keys-export', 'settings.roomKeysExport', 'settings.roomKeysExportDescription'],
          ['room-keys-import', 'settings.roomKeysImport', 'settings.roomKeysImportDescription'],
        ]),
      ],
    },
  ],
  developer: [
    {
      id: 'developer-access-token',
      section: 'developer-options',
      supported: developerTools,
      targets: targets([['access-token', 'settings.developerAccessTokenTitle']]),
    },
    {
      id: 'developer-sync-diagnostics',
      section: 'developer-sync-diagnostics',
      supported: developerTools,
      targets: targets([
        ['developer-sync-diagnostics', 'settings.developerSyncTitle'],
        ['sync-state', 'settings.developerSyncState'],
        ['sync-core-status', 'settings.developerSyncCoreStatus'],
        ['sync-rooms', 'settings.developerSyncRooms'],
        ['sync-account', 'settings.developerSyncAccount'],
        ['sync-revision', 'settings.developerSyncRevision'],
        ['sync-unresponsive', 'settings.developerSyncUnresponsive'],
      ]),
    },
    {
      id: 'developer-server-features',
      section: 'developer-server-features',
      supported: developerTools,
      targets: targets([
        ['developer-server-features', 'settings.developerServerFeaturesTitle'],
        ['server-feature-org.matrix.simplified_msc3575', 'settings.serverFeatureSlidingSync'],
        ['server-feature-org.matrix.msc4140', 'settings.callCompatDelayed'],
        ['server-feature-org.matrix.msc4354', 'settings.callCompatSticky'],
        [
          'server-feature-computer.gingershaped.msc4466',
          'settings.serverFeatureProfilePropagation',
        ],
      ]),
    },
    {
      id: 'developer-account-data',
      section: 'developer-account-data',
      supported: developerTools,
      targets: targets([
        ['developer-account-data', 'settings.developerAccountDataTitle'],
        ['account-data-add', 'settings.developerAccountDataAdd'],
      ]),
    },
    {
      id: 'developer-push-rules',
      section: 'developer-push-rules',
      supported: developerTools,
      targets: targets([['developer-push-rules', 'settings.developerPushRulesTitle']]),
    },
    {
      id: 'developer-notifications',
      section: 'developer-notifications',
      supported: developerTools,
      targets: targets([
        ['developer-notifications', 'settings.developerNotificationsTitle'],
        ['send-test-notification', 'settings.developerNotificationsTitle'],
        ['push-outcomes', 'settings.developerPushOutcomesTitle'],
      ]),
    },
    {
      id: 'developer-push-history',
      section: 'developer-notifications',
      supported: developerTools,
      targets: targets([['push-history', 'settings.developerPushHistoryTitle']]),
    },
    {
      id: 'developer-debug-logs',
      section: 'developer-debug-logs',
      supported: developerTools,
      targets: targets([
        ['developer-debug-logs', 'settings.developerLogsTitle'],
        ['debug-logs-status', 'settings.developerLogsStatus'],
      ]),
    },
    {
      id: 'developer-sentry',
      section: 'developer-sentry',
      supported: developerTools,
      targets: targets([
        ['developer-sentry', 'settings.developerSentryTitle'],
        ['sentry-configured', 'settings.developerSentryConfigured'],
        ['sentry-environment', 'settings.developerSentryEnvironment'],
        ['sentry-reporting', 'settings.developerSentryReporting'],
        ['sentry-replay', 'settings.developerSentryReplay'],
        ['sentry-activity', 'settings.developerSentryActivity'],
      ]),
    },
    {
      id: 'state-event',
      section: 'settings-state-event',
      supported: developerTools,
      targets: targets([['settings-state-event', 'settings.stateEventTitle']]),
    },
  ],
};
