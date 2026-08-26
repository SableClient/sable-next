import type { Component } from 'svelte';

import { preferences } from '#lib/settings/preferences.svelte.js';

import CustomThemes from '#lib/features/settings/CustomThemes.svelte';
import NotificationDefaults from '#lib/features/notifications/NotificationDefaults.svelte';
import PersonaSettings from '#lib/features/settings/PersonaSettings.svelte';
import PushGateway from '#lib/features/notifications/PushGateway.svelte';
import StateEventTool from '#lib/features/settings/StateEventTool.svelte';

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
      component: StateEventTool,
      when: () => preferences.showHiddenEvents,
      title: 'settings.stateEventTitle',
      headingId: 'settings-state-event',
      class: 'state-event-section',
    },
  ],
};

export function panelsFor(categoryId: string): CategoryPanel[] {
  return categoryPanels[categoryId] ?? [];
}
