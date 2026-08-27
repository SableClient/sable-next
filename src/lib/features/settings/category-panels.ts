import type { Component } from 'svelte';

import { preferences } from '#lib/settings/preferences.svelte.js';

import CustomThemes from '#lib/features/settings/CustomThemes.svelte';
import NotificationDefaults from '#lib/features/notifications/NotificationDefaults.svelte';
import PersonaSettings from '#lib/features/settings/PersonaSettings.svelte';
import PushGateway from '#lib/features/notifications/PushGateway.svelte';
import StateEventTool from '#lib/features/settings/StateEventTool.svelte';
import DeveloperAccessToken from '#lib/features/settings/DeveloperAccessToken.svelte';
import DeveloperAccountData from '#lib/features/settings/DeveloperAccountData.svelte';
import DeveloperDebugLogs from '#lib/features/settings/DeveloperDebugLogs.svelte';
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
  appearance: [{ component: CustomThemes, class: 'custom-themes-card' }],
  notifications: [{ component: NotificationDefaults }, { component: PushGateway }],
  personas: [{ component: PersonaSettings, class: 'personas-card' }],
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
      class: 'state-event-section',
    },
  ],
};

export function panelsFor(categoryId: string): CategoryPanel[] {
  return categoryPanels[categoryId] ?? [];
}
