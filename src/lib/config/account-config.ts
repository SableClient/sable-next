import { ACCOUNT_PREFERENCES } from '#lib/settings/definitions.js';
import { parseRuntimeConfig, type RuntimeConfig } from './runtime-config.js';
import { isRecord } from '#lib/guards.js';

export type AccountConfig = {
  branding?: Partial<RuntimeConfig['branding']>;
  links?: Partial<RuntimeConfig['links']>;
  auth?: Partial<RuntimeConfig['auth']>;
  hideCommunityLinks?: boolean;
  hideUsernamePasswordFields?: boolean;
  settingsDefaults?: Record<string, unknown>;
  settingsLocked?: Record<string, unknown>;
};

export function parseAccountConfig(raw: unknown, source: string): AccountConfig | null {
  if (!isRecord(raw)) return null;
  const input: Record<string, unknown> = {
    ...raw,
    ...(isRecord(raw.branding) ? { branding: { ...raw.branding } } : {}),
  };
  if (isRecord(input.branding)) {
    for (const key of ['logoUrl', 'faviconUrl', 'themeUrl']) {
      const value = input.branding[key];
      if (typeof value !== 'string') continue;
      try {
        const url = new URL(value, source);
        input.branding[key] = url.protocol === 'https:' ? url.href : undefined;
      } catch {
        input.branding[key] = undefined;
      }
    }
  }
  const parsed = parseRuntimeConfig(input);
  const result: AccountConfig = {};
  for (const section of ['branding', 'links', 'auth'] as const) {
    const values = input[section];
    if (!isRecord(values)) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed[section])) {
      if (!(key in values) || values[key] === undefined) continue;
      if (value === null && values[key] !== null) continue;
      if (typeof value === 'boolean' && typeof values[key] !== 'boolean') continue;
      if (
        key === 'terms' &&
        (!Array.isArray(values[key]) ||
          !Array.isArray(value) ||
          value.length !== values[key].length)
      )
        continue;
      fields[key] = value;
    }
    result[section] = fields;
  }
  for (const key of ['hideCommunityLinks', 'hideUsernamePasswordFields'] as const) {
    if (typeof input[key] === 'boolean') result[key] = input[key];
  }
  for (const key of ['settingsDefaults', 'settingsLocked'] as const) {
    const values = input[key];
    if (isRecord(values))
      result[key] = Object.fromEntries(
        ACCOUNT_PREFERENCES.filter((name) => name in values).map((name) => [name, values[name]])
      );
  }
  return result;
}

export function accountConfigUrl(server: string): string | null {
  try {
    const url = new URL(server.includes('://') ? server : `https://${server}`);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return new URL('/.well-known/sable', url.origin).href;
  } catch {
    return null;
  }
}

export function mergeAccountConfig(
  base: RuntimeConfig,
  account: AccountConfig | null
): RuntimeConfig {
  if (!account) return base;
  return {
    ...base,
    ...account,
    branding: { ...base.branding, ...account.branding },
    links: { ...base.links, ...account.links },
    auth: {
      ...base.auth,
      ...account.auth,
      disableRegistration:
        base.auth.disableRegistration || account.auth?.disableRegistration === true,
      ssoRedirect: base.auth.ssoRedirect ?? account.auth?.ssoRedirect ?? null,
    },
    hideUsernamePasswordFields:
      base.hideUsernamePasswordFields || account.hideUsernamePasswordFields === true,
    settingsDefaults: { ...base.settingsDefaults, ...account.settingsDefaults },
    settingsLocked: { ...account.settingsLocked, ...base.settingsLocked },
  };
}
