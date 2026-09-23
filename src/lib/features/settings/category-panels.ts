import type { Component } from 'svelte';

import { preferences } from '#lib/settings/preferences.svelte.js';

import AppIconSettings from '#lib/features/settings/AppIconSettings.svelte';
import ComposerButtonOrder from '#lib/features/settings/ComposerButtonOrder.svelte';
import CallDeviceSettings from '#lib/features/call/CallDeviceSettings.svelte';
import CustomThemes from '#lib/features/settings/CustomThemes.svelte';
import MentionNotifications from '#lib/features/notifications/MentionNotifications.svelte';
import NotificationDefaults from '#lib/features/notifications/NotificationDefaults.svelte';
import NotificationKeywords from '#lib/features/settings/NotificationKeywords.svelte';
import PersonaSettings from '#lib/features/settings/PersonaSettings.svelte';
import PushGateway from '#lib/features/notifications/PushGateway.svelte';
import PushersSettings from '#lib/features/notifications/PushersSettings.svelte';
import SettingsFile from '#lib/features/settings/SettingsFile.svelte';
import SettingsSyncStatus from '#lib/features/settings/SettingsSyncStatus.svelte';
import StateEventTool from '#lib/features/settings/StateEventTool.svelte';
import DeveloperAccessToken from '#lib/features/settings/DeveloperAccessToken.svelte';
import DeveloperAccountData from '#lib/features/settings/DeveloperAccountData.svelte';
import DeveloperDebugLogs from '#lib/features/settings/DeveloperDebugLogs.svelte';
import DeveloperNotifications from '#lib/features/settings/DeveloperNotifications.svelte';
import DeveloperSentry from '#lib/features/settings/DeveloperSentry.svelte';
import DeveloperSyncDiagnostics from '#lib/features/settings/DeveloperSyncDiagnostics.svelte';

interface BasePanel {
  component: Component;
  when?: () => boolean;
  class?: string;
}

export type CategoryPanel =
  | (BasePanel & { title?: undefined; headingId?: undefined })
  | (BasePanel & { title: string; headingId: string });

export const categoryPanels: Record<string, CategoryPanel[]> = {
  appearance: [{ component: CustomThemes }, { component: AppIconSettings }],
  composer: [
    {
      component: ComposerButtonOrder,
      title: 'settings.composerButtonOrder',
      headingId: 'composer-button-order',
    },
  ],
  notifications: [
    { component: NotificationDefaults },
    { component: MentionNotifications },
    { component: NotificationKeywords },
    { component: PushersSettings },
    { component: PushGateway },
  ],
  calls: [
    {
      component: CallDeviceSettings,
      title: 'settings.callDevicesTitle',
      headingId: 'call-devices',
    },
  ],
  personas: [{ component: PersonaSettings }],
  sync: [
    { component: SettingsSyncStatus, when: () => preferences.settingsSync },
    { component: SettingsFile },
  ],
  developer: [
    {
      component: DeveloperAccessToken,
      when: () => preferences.developerTools,
    },
    {
      component: DeveloperSyncDiagnostics,
      when: () => preferences.developerTools,
      title: 'settings.developerSyncTitle',
      headingId: 'developer-sync-diagnostics',
    },
    {
      component: DeveloperAccountData,
      when: () => preferences.developerTools,
      title: 'settings.developerAccountDataTitle',
      headingId: 'developer-account-data',
    },
    {
      component: DeveloperNotifications,
      when: () => preferences.developerTools,
      title: 'settings.developerNotificationsTitle',
      headingId: 'developer-notifications',
    },
    {
      component: DeveloperDebugLogs,
      when: () => preferences.developerTools,
      title: 'settings.developerLogsTitle',
      headingId: 'developer-debug-logs',
    },
    {
      component: DeveloperSentry,
      when: () => preferences.developerTools,
      title: 'settings.developerSentryTitle',
      headingId: 'developer-sentry',
    },
    {
      component: StateEventTool,
      when: () => preferences.developerTools,
      title: 'settings.stateEventTitle',
      headingId: 'settings-state-event',
    },
  ],
};

export function panelsFor(categoryId: string): CategoryPanel[] {
  return categoryPanels[categoryId] ?? [];
}
