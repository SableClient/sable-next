import { untrack } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
  readJson,
  readText,
  removeLocalValue,
  writeJson,
  writeText,
} from '#lib/platform/local-json.js';
import { migrateSettings, SETTINGS_SCHEMA } from './migrations.js';
import {
  ACCOUNT_PREFERENCES,
  ACCOUNT_STORED_PREFERENCES,
  DEFAULTS,
  NON_SYNCABLE_KEYS,
  PREFERENCE_KEYS,
  sanitize,
  type Preferences,
} from './definitions.js';

const STORAGE_KEY = 'sable-preferences';
const ACCOUNT_STORAGE_KEY = 'sable-account-preferences';
const LEGACY_STORAGE_KEY = 'sable-timeline-preferences';
const LAST_ACCOUNT_KEY = 'sable-settings-account';

function read(key: string): Record<string, unknown> | null {
  return readJson(
    key,
    (parsed) =>
      typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null,
    null
  );
}

const explicit = new SvelteSet<keyof Preferences>();
const locked = new SvelteSet<keyof Preferences>();
const userValues = new SvelteMap<keyof Preferences, unknown>();
let deploymentDefaults: Partial<Preferences> = {};
let deploymentLocks: Partial<Preferences> = {};
let accountDefaults: Partial<Preferences> = {};
let accountLocks = $state.raw<Partial<Preferences>>({});

function load(): Preferences {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS };

  const current = read(STORAGE_KEY) ?? read(LEGACY_STORAGE_KEY);
  if (!current) return { ...DEFAULTS };

  const stored = migrateSettings(current, current.schema);
  const loaded = sanitize(stored, DEFAULTS);
  for (const key of PREFERENCE_KEYS) {
    if (key in stored || loaded[key] !== DEFAULTS[key]) explicit.add(key);
  }
  return loaded;
}

export const preferences = $state<Preferences>(load());
for (const key of explicit) userValues.set(key, preferences[key]);

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- read only when switching accounts
const sharedValues = new Map(
  [...userValues].filter(([key]) => ACCOUNT_STORED_PREFERENCES.has(key))
);
let activeAccount: string | null = null;

export function lastSettingsAccount(): string | null {
  return readText(LAST_ACCOUNT_KEY);
}

export function accountPreferencesSettled(accountId: string): boolean {
  return 'schema' in (storedAccounts()[accountId] ?? {});
}

const PRESENCE_KEYS: ReadonlySet<keyof Preferences> = new Set([
  'presence',
  'presenceStatusMessage',
]);

function hasOtherAccount(accountId: string | null): boolean {
  return Object.keys(storedAccounts()).some((id) => id !== accountId);
}

function storedAccounts(): Record<string, Record<string, unknown>> {
  return (read(ACCOUNT_STORAGE_KEY) ?? {}) as Record<string, Record<string, unknown>>;
}

export function selectPreferenceAccount(
  accountId: string | null,
  seed?: Partial<Preferences>
): void {
  if (accountId === activeAccount) return;
  activeAccount = accountId;
  if (accountId === null) removeLocalValue(LAST_ACCOUNT_KEY);
  else writeText(LAST_ACCOUNT_KEY, accountId);
  const stored = accountId === null ? undefined : storedAccounts()[accountId];
  const settled = stored !== undefined && 'schema' in stored;
  const own = stored && migrateSettings(stored, stored.schema);
  const values = own ? sanitize(own, DEFAULTS) : null;
  for (const key of ACCOUNT_STORED_PREFERENCES) {
    let value: unknown;
    if (own && key in own) value = values?.[key];
    else if (settled) value = undefined;
    else if (seed && !NON_SYNCABLE_KEYS.has(key)) value = seed[key];
    else if (PRESENCE_KEYS.has(key) && hasOtherAccount(accountId)) value = undefined;
    else value = sharedValues.get(key);
    if (value === undefined) {
      userValues.delete(key);
      explicit.delete(key);
    } else {
      userValues.set(key, value);
      explicit.add(key);
    }
  }
  resolvePolicy();
  if (accountId !== null && !settled) persist();
}

export function readReceiptIsPrivate(): boolean {
  return !preferences.sendReadReceipts;
}

export function isExplicitPreference(key: keyof Preferences): boolean {
  return explicit.has(key) && !locked.has(key);
}

export function isLockedPreference(key: keyof Preferences): boolean {
  return locked.has(key);
}

export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  if (locked.has(key)) return;
  preferences[key] = value;
  userValues.set(key, value);
  explicit.add(key);
  persist();
}

function assign<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  preferences[key] = value;
}

export function applyPreferences(
  next: Preferences,
  keys: readonly (keyof Preferences)[] = PREFERENCE_KEYS
): void {
  for (const key of keys) {
    if (locked.has(key)) continue;
    userValues.set(key, next[key]);
    explicit.add(key);
  }
  resolvePolicy();
  persist();
}

const UNSET = Object.fromEntries(
  PREFERENCE_KEYS.map((key) => [key, undefined])
) as unknown as Preferences;

function validPolicy(raw: Record<string, unknown>): Partial<Preferences> {
  return Object.fromEntries(
    Object.entries<unknown>(sanitize(raw, UNSET)).filter(
      ([key, value]) => key in raw && value !== undefined
    )
  );
}

export function applyDeploymentDefaults(raw: Record<string, unknown>): void {
  deploymentDefaults = validPolicy(raw);
  resolvePolicy();
}

export function applyDeploymentLocks(raw: Record<string, unknown>): void {
  deploymentLocks = validPolicy(raw);
  resolvePolicy();
}

// Keep remote settings out of stored user preferences.
export function applyAccountPreferences(
  defaults: Record<string, unknown>,
  locks: Record<string, unknown>
): void {
  const supported = (raw: Record<string, unknown>) =>
    validPolicy(
      Object.fromEntries(
        ACCOUNT_PREFERENCES.filter((key) => key in raw).map((key) => [key, raw[key]])
      )
    );
  accountDefaults = supported(defaults);
  const nextLocks = supported(locks);
  if (nextLocks.sendReadReceipts === false) nextLocks.hideReadReceipts = true;
  accountLocks = nextLocks;
  resolvePolicy();
}

export function accountDisablesReadReceipts(): boolean {
  return accountLocks.sendReadReceipts === false && !preferences.sendReadReceipts;
}

function resolvePolicy(): void {
  for (const key of PREFERENCE_KEYS) {
    const value = deploymentLocks[key] ?? accountLocks[key];
    if (value !== undefined) locked.add(key);
    else locked.delete(key);
    assign(
      key,
      (value ??
        userValues.get(key) ??
        accountDefaults[key] ??
        deploymentDefaults[key] ??
        DEFAULTS[key]) as Preferences[typeof key]
    );
  }
}

function persist(): void {
  untrack(() => {
    const stored: Record<string, unknown> = { schema: SETTINGS_SCHEMA };
    const own: Record<string, unknown> = { schema: SETTINGS_SCHEMA };
    for (const key of explicit) {
      if (activeAccount !== null && ACCOUNT_STORED_PREFERENCES.has(key))
        own[key] = userValues.get(key);
      else stored[key] = userValues.get(key);
    }
    if (activeAccount === null) {
      for (const key of ACCOUNT_STORED_PREFERENCES) {
        if (explicit.has(key)) sharedValues.set(key, userValues.get(key));
      }
    } else {
      for (const [key, value] of sharedValues) stored[key] = value;
      writeJson(
        ACCOUNT_STORAGE_KEY,
        { ...storedAccounts(), [activeAccount]: own },
        '[sable settings] account preferences not persisted'
      );
    }
    writeJson(STORAGE_KEY, stored, '[sable settings] preferences not persisted');
  });
}

selectPreferenceAccount(lastSettingsAccount());
