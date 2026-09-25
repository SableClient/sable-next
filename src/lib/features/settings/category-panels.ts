import type { Component } from 'svelte';

import { usesPushGateway } from '#lib/platform/notifications.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { SETTINGS_ACCOUNT_SECTION } from '#lib/settings/registry.js';

import AppIconSettings from '#lib/features/settings/AppIconSettings.svelte';
import ComposerButtonOrder from '#lib/features/settings/ComposerButtonOrder.svelte';
import CallDeviceSettings from '#lib/features/call/CallDeviceSettings.svelte';
import CustomThemes from '#lib/features/settings/CustomThemes.svelte';
import MentionNotifications from '#lib/features/notifications/MentionNotifications.svelte';
import NotificationDefaults from '#lib/features/notifications/NotificationDefaults.svelte';
import NotificationPermission from '#lib/features/notifications/NotificationPermission.svelte';
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
import DeveloperSearchMetrics from '#lib/features/settings/DeveloperSearchMetrics.svelte';
import DeveloperSentry from '#lib/features/settings/DeveloperSentry.svelte';
import DeveloperSyncDiagnostics from '#lib/features/settings/DeveloperSyncDiagnostics.svelte';

export interface CategoryPanel {
  component: Component;
  section?: string;
  start?: true;
  when?: () => boolean;
}

export const categoryPanels: Record<string, CategoryPanel[]> = {
  appearance: [
    { component: CustomThemes, section: 'themes' },
    { component: AppIconSettings, section: 'themes' },
  ],
  composer: [{ component: ComposerButtonOrder, section: 'composer-button-order' }],
  notifications: [
    { component: NotificationPermission, section: 'alerts', start: true },
    { component: NotificationDefaults },
    { component: MentionNotifications },
    { component: NotificationKeywords },
    { component: PushersSettings },
    { component: PushGateway, when: usesPushGateway },
  ],
  calls: [{ component: CallDeviceSettings, section: 'call-devices' }],
  personas: [{ component: PersonaSettings }],
  [SETTINGS_ACCOUNT_SECTION]: [
    { component: SettingsSyncStatus, section: 'sync', when: () => preferences.settingsSync },
    { component: SettingsFile, section: 'sync' },
  ],
  developer: [
    {
      component: DeveloperAccessToken,
      section: 'developer-options',
      when: () => preferences.developerTools,
    },
    {
      component: DeveloperSyncDiagnostics,
      section: 'developer-sync-diagnostics',
      when: () => preferences.developerTools,
    },
    {
      component: DeveloperSearchMetrics,
      section: 'developer-search-metrics',
      when: () => preferences.developerTools,
    },
    {
      component: DeveloperAccountData,
      section: 'developer-account-data',
      when: () => preferences.developerTools,
    },
    {
      component: DeveloperNotifications,
      section: 'developer-notifications',
      when: () => preferences.developerTools,
    },
    {
      component: DeveloperDebugLogs,
      section: 'developer-debug-logs',
      when: () => preferences.developerTools,
    },
    {
      component: DeveloperSentry,
      section: 'developer-sentry',
      when: () => preferences.developerTools,
    },
    {
      component: StateEventTool,
      section: 'settings-state-event',
      when: () => preferences.developerTools,
    },
  ],
};

export function panelsFor(categoryId: string): CategoryPanel[] {
  return categoryPanels[categoryId] ?? [];
}
