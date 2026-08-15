export type TimelineLayout = 'modern' | 'compact' | 'bubble';

export interface TimelinePreferences {
  layout: TimelineLayout;
  hideMembershipEvents: boolean;
  hideProfileChanges: boolean;
  hideMemberInReadOnly: boolean;
  showTombstoneEvents: boolean;
  showHiddenEvents: boolean;
  showNonStandardEvents: boolean;
}

const STORAGE_KEY = 'sable-timeline-preferences';
const LAYOUTS: TimelineLayout[] = ['modern', 'compact', 'bubble'];

const DEFAULTS: TimelinePreferences = {
  layout: 'modern',
  hideMembershipEvents: false,
  hideProfileChanges: true,
  hideMemberInReadOnly: true,
  showTombstoneEvents: false,
  showHiddenEvents: false,
  showNonStandardEvents: false,
};

function load(): TimelinePreferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };

  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return { ...DEFAULTS };
  }
  if (typeof stored !== 'object' || stored === null) return { ...DEFAULTS };

  const record = stored as Record<string, unknown>;
  const preferences = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof TimelinePreferences)[]) {
    const value = record[key];
    if (key === 'layout') {
      if (LAYOUTS.includes(value as TimelineLayout)) preferences.layout = value as TimelineLayout;
    } else if (typeof value === 'boolean') {
      preferences[key] = value;
    }
  }
  return preferences;
}

export const timelinePreferences = $state<TimelinePreferences>(load());

export function setTimelinePreference<K extends keyof TimelinePreferences>(
  key: K,
  value: TimelinePreferences[K]
): void {
  timelinePreferences[key] = value;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(timelinePreferences));
  } catch (error) {
    console.debug('[sable settings] timeline preferences not persisted', error);
  }
}
