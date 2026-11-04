import { readJson, writeJson, removeLocalValue } from '#lib/platform/local-json.js';
import { isRecord } from '#lib/guards.js';
import { accountConfigUrl, parseAccountConfig, type AccountConfig } from './account-config.js';

const requests = new Map<string, Promise<AccountConfig | null | undefined>>();
const key = (accountId: string) => `sable.account-config.${accountId}`;

export function cachedAccountConfig(accountId: string, source: string): AccountConfig | null {
  return readJson(
    key(accountId),
    (raw) => {
      if (!isRecord(raw) || raw.source !== source) return null;
      return parseAccountConfig(raw.config, source);
    },
    null
  );
}

export function removeAccountConfiguration(accountId: string): void {
  removeLocalValue(key(accountId));
}

/** undefined is a temporary failure; null is an absent or explicitly cleared configuration. */
export async function discoverAccountConfig(
  server: string
): Promise<AccountConfig | null | undefined> {
  const source = accountConfigUrl(server);
  if (!source) return null;
  let request = requests.get(source);
  if (!request) {
    request = (async () => {
      try {
        const response = await fetch(source, {
          credentials: 'omit',
          cache: 'no-cache',
          signal: AbortSignal.timeout(5000),
        });
        if (response.status === 404 || response.status === 410) return null;
        if (!response.ok) return undefined;
        return parseAccountConfig(await response.json(), response.url || source) ?? undefined;
      } catch {
        return undefined;
      }
    })();
    requests.set(source, request);
  }
  return request;
}

export function storeAccountConfig(
  accountId: string,
  source: string,
  config: AccountConfig | null
): void {
  if (config === null || Object.keys(config).length === 0) removeAccountConfiguration(accountId);
  else writeJson(key(accountId), { source, config });
}
