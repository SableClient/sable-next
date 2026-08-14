export interface TimelinePreferences {
  hideMembershipEvents: boolean;
  hideProfileChanges: boolean;
  showHiddenEvents: boolean;
}

const STORAGE_KEY = 'sable-timeline-preferences';

/** Hiding profile changes by default follows Sable v1's `hideNickAvatarEvents`. */
const DEFAULTS: TimelinePreferences = {
  hideMembershipEvents: false,
  hideProfileChanges: true,
  showHiddenEvents: false,
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

  // Anything the user hand-edited or an older build wrote falls back per key.
  const record = stored as Record<string, unknown>;
  const preferences = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof TimelinePreferences)[]) {
    if (typeof record[key] === 'boolean') preferences[key] = record[key];
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
  } catch {
    // Private browsing can refuse writes; the in-memory value still applies.
  }
}
