import type { Component } from 'svelte';

import {
  settingsPanels,
  type SettingsContext,
  type SettingsPanelDefinition,
} from '#lib/settings/registry.js';

import AppIconSettings from '#lib/features/settings/AppIconSettings.svelte';
import CallCompatibilityDebug from '#lib/features/settings/CallCompatibilityDebug.svelte';
import CallDeviceSettings from '#lib/features/call/CallDeviceSettings.svelte';
import CallServiceSettings from '#lib/features/call/CallServiceSettings.svelte';
import ComposerButtons from '#lib/features/settings/ComposerButtons.svelte';
import ComposerEnterSetting from '#lib/features/settings/ComposerEnterSetting.svelte';
import CustomThemes from '#lib/features/settings/CustomThemes.svelte';
import FontSettings from '#lib/features/settings/FontSettings.svelte';
import QuickCss from '#lib/features/settings/QuickCss.svelte';
import LinkDeviceSetting from '#lib/features/settings/LinkDeviceSetting.svelte';
import DoubleTapReaction from '#lib/features/settings/DoubleTapReaction.svelte';
import MatrixLinkHandler from '#lib/features/settings/MatrixLinkHandler.svelte';
import MediaPreviewPrivacy from '#lib/features/settings/MediaPreviewPrivacy.svelte';
import MentionNotifications from '#lib/features/notifications/MentionNotifications.svelte';
import NotificationTroubleshooter from '#lib/features/notifications/NotificationTroubleshooter.svelte';
import NotificationDefaults from '#lib/features/notifications/NotificationDefaults.svelte';
import NotificationPermission from '#lib/features/notifications/NotificationPermission.svelte';
import NotificationKeywords from '#lib/features/settings/NotificationKeywords.svelte';
import NotificationRoomModes from '#lib/features/notifications/NotificationRoomModes.svelte';
import PersonaSettings from '#lib/features/settings/PersonaSettings.svelte';
import PushGateway from '#lib/features/notifications/PushGateway.svelte';
import PushersSettings from '#lib/features/notifications/PushersSettings.svelte';
import SettingsFile from '#lib/features/settings/SettingsFile.svelte';
import SettingsSyncStatus from '#lib/features/settings/SettingsSyncStatus.svelte';
import SyncEncryption from '#lib/features/settings/SyncEncryption.svelte';
import StateEventTool from '#lib/features/settings/StateEventTool.svelte';
import DeveloperAccessToken from '#lib/features/settings/DeveloperAccessToken.svelte';
import DeveloperAccountData from '#lib/features/settings/DeveloperAccountData.svelte';
import DeveloperPushRules from '#lib/features/settings/DeveloperPushRules.svelte';
import DeveloperDebugLogs from '#lib/features/settings/DeveloperDebugLogs.svelte';
import DeveloperNotifications from '#lib/features/settings/DeveloperNotifications.svelte';
import DeveloperPushHistory from '#lib/features/settings/DeveloperPushHistory.svelte';
import DeveloperSearchMetrics from '#lib/features/settings/DeveloperSearchMetrics.svelte';
import SearchSharingStatus from '#lib/features/settings/SearchSharingStatus.svelte';
import DeveloperSentry from '#lib/features/settings/DeveloperSentry.svelte';
import PresenceSharingSettings from '#lib/features/settings/PresenceSharingSettings.svelte';
import DeveloperServerFeatures from '#lib/features/settings/DeveloperServerFeatures.svelte';
import DeveloperSyncDiagnostics from '#lib/features/settings/DeveloperSyncDiagnostics.svelte';
import SoundVolumeSettings from '../call/SoundVolumeSettings.svelte';

export interface CategoryPanel extends SettingsPanelDefinition {
  component: Component;
}

export const panelComponents: Partial<Record<string, Component>> = {
  'custom-themes': CustomThemes,
  'quick-css': QuickCss,
  'app-icon': AppIconSettings,
  font: FontSettings,
  'composer-enter': ComposerEnterSetting,
  'composer-buttons': ComposerButtons,
  'double-tap-reaction': DoubleTapReaction,
  'matrix-link-handler': MatrixLinkHandler,
  'developer-search-metrics': DeveloperSearchMetrics,
  'search-sharing-status': SearchSharingStatus,
  'notification-permission': NotificationPermission,
  'notification-defaults': NotificationDefaults,
  'mention-notifications': MentionNotifications,
  'notification-keywords': NotificationKeywords,
  'notification-rooms': NotificationRoomModes,
  pushers: PushersSettings,
  'push-gateway': PushGateway,
  'notification-troubleshoot': NotificationTroubleshooter,
  'call-devices': CallDeviceSettings,
  'call-service': CallServiceSettings,
  'call-compat': CallCompatibilityDebug,
  'sound-volumes': SoundVolumeSettings,
  'media-preview-privacy': MediaPreviewPrivacy,
  'presence-sharing': PresenceSharingSettings,
  personas: PersonaSettings,
  'link-device': LinkDeviceSetting,
  'settings-sync-status': SettingsSyncStatus,
  'sync-encryption': SyncEncryption,
  'settings-file': SettingsFile,
  'developer-access-token': DeveloperAccessToken,
  'developer-sync-diagnostics': DeveloperSyncDiagnostics,
  'developer-server-features': DeveloperServerFeatures,
  'developer-account-data': DeveloperAccountData,
  'developer-push-rules': DeveloperPushRules,
  'developer-notifications': DeveloperNotifications,
  'developer-push-history': DeveloperPushHistory,
  'developer-debug-logs': DeveloperDebugLogs,
  'developer-sentry': DeveloperSentry,
  'state-event': StateEventTool,
};

export function panelsFor(categoryId: string, context: SettingsContext): CategoryPanel[] {
  return (settingsPanels[categoryId] ?? []).flatMap((panel) => {
    const component = panelComponents[panel.id];
    if (!component || panel.supported?.(context) === false) return [];
    return [{ ...panel, component }];
  });
}
