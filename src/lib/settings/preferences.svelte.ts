export type TimelineLayout = 'modern' | 'compact' | 'bubble';
export type MessageSpacing = 'compact' | 'cozy' | 'roomy';
export type DateFormat = 'auto' | 'dmy' | 'mdy' | 'ymd';
export type ThemeMode = 'system' | 'dark' | 'light';

export interface Preferences {
  layout: TimelineLayout;
  messageSpacing: MessageSpacing;
  theme: ThemeMode;
  underlineLinks: boolean;

  hour24Clock: boolean;
  dateFormat: DateFormat;

  hideMembershipEvents: boolean;
  hideProfileChanges: boolean;
  hideMemberInReadOnly: boolean;
  showTombstoneEvents: boolean;
  hideReadReceipts: boolean;
  hideTypingIndicators: boolean;

  enterForNewline: boolean;
  formattingToolbar: boolean;

  sendTypingNotifications: boolean;
  sendReadReceipts: boolean;
  sendPresence: boolean;

  mediaAutoLoad: boolean;
  autoplayGifs: boolean;
  urlPreviews: boolean;

  desktopNotifications: boolean;
  notificationSounds: boolean;
  notificationContent: boolean;

  /** Empty falls back to `config.json`; see `hasCompleteOverride`. */
  pushGatewayUrl: string;
  pushVapidKey: string;
  pushAppId: string;

  errorReporting: boolean;
  sessionReplay: boolean;
  /** Distinguishes a declined prompt from one that was never shown. */
  telemetryAsked: boolean;

  showHiddenEvents: boolean;
  showNonStandardEvents: boolean;
}

/** The subset the timeline reads when deciding which events to render. */
export type TimelinePreferences = Pick<
  Preferences,
  | 'layout'
  | 'hideMembershipEvents'
  | 'hideProfileChanges'
  | 'hideMemberInReadOnly'
  | 'showTombstoneEvents'
  | 'showHiddenEvents'
  | 'showNonStandardEvents'
>;

const STORAGE_KEY = 'sable-preferences';
const LEGACY_STORAGE_KEY = 'sable-timeline-preferences';

const ENUMS = {
  layout: ['modern', 'compact', 'bubble'],
  messageSpacing: ['compact', 'cozy', 'roomy'],
  theme: ['system', 'dark', 'light'],
  dateFormat: ['auto', 'dmy', 'mdy', 'ymd'],
} as const satisfies Partial<Record<keyof Preferences, readonly string[]>>;

/** Strings with no fixed set of values, which the loader would otherwise drop. */
const FREE_TEXT = [
  'pushGatewayUrl',
  'pushVapidKey',
  'pushAppId',
] as const satisfies readonly (keyof Preferences)[];

/** Excluded from `SelectPreference`, since these have no fixed set of choices. */
export type FreeTextPreference = (typeof FREE_TEXT)[number];

const DEFAULTS: Preferences = {
  layout: 'modern',
  messageSpacing: 'cozy',
  theme: 'system',
  underlineLinks: true,

  hour24Clock: false,
  dateFormat: 'auto',

  hideMembershipEvents: false,
  hideProfileChanges: true,
  hideMemberInReadOnly: true,
  showTombstoneEvents: false,
  hideReadReceipts: false,
  hideTypingIndicators: false,

  enterForNewline: false,
  formattingToolbar: false,

  sendTypingNotifications: true,
  sendReadReceipts: true,
  sendPresence: true,

  mediaAutoLoad: true,
  autoplayGifs: true,
  urlPreviews: false,

  desktopNotifications: false,
  notificationSounds: true,
  notificationContent: false,

  pushGatewayUrl: '',
  pushVapidKey: '',
  pushAppId: '',

  errorReporting: false,
  sessionReplay: false,
  telemetryAsked: false,

  showHiddenEvents: false,
  showNonStandardEvents: false,
};

function read(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function load(): Preferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };

  const stored = read(STORAGE_KEY) ?? read(LEGACY_STORAGE_KEY);
  if (!stored) return { ...DEFAULTS };

  const preferences = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Preferences)[]) {
    const value = stored[key];
    const allowed: readonly string[] | undefined =
      key in ENUMS ? ENUMS[key as keyof typeof ENUMS] : undefined;
    if (allowed) {
      if (typeof value === 'string' && allowed.includes(value)) {
        (preferences as Record<string, unknown>)[key] = value;
      }
    } else if ((FREE_TEXT as readonly string[]).includes(key)) {
      if (typeof value === 'string') (preferences as Record<string, unknown>)[key] = value;
    } else if (typeof value === 'boolean') {
      (preferences as Record<string, unknown>)[key] = value;
    }
  }
  return preferences;
}

export const preferences = $state<Preferences>(load());

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  preferences[key] = value;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.debug('[sable settings] preferences not persisted', error);
  }
}
