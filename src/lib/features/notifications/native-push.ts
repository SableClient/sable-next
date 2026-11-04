import type { SessionInfo } from '#src/generated/protocol';

import { deliversNativePush } from '#lib/platform/notifications.js';
import {
  registerNativePushConfig,
  unregisterNativePushConfig,
  listPushDistributors,
  setPushDistributor,
  type NativePushAccount,
} from '#lib/platform/push.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import {
  embeddedServer,
  hasCompleteOverride,
  pushConfig,
  type PushOverride,
} from '#lib/notifications/push-config.js';
import {
  clearPushFailure,
  lastPushFailure,
  PushConfigMissing,
  recordPushFailure,
} from './push-failure';

export class NoDistributorError extends Error {
  constructor() {
    super('No UnifiedPush distributor is available');
  }
}

export type PushProvider = 'auto' | 'fcm' | 'unifiedpush' | 'embedded';

async function register(
  override: PushOverride,
  session: SessionInfo | null,
  accounts: readonly SessionInfo[],
  provider: PushProvider = selectedPushProvider()
): Promise<void> {
  if (!deliversNativePush()) return;

  const { resolved, details } = await pushConfig(override);
  if (!resolved) throw new PushConfigMissing();

  await registerNativePushConfig({
    gatewayUrl: resolved.gateway,
    gatewayOverride: hasCompleteOverride(override),
    vapidKey: resolved.vapid,
    webAppId: resolved.appId,
    nativeAppId:
      details !== null && resolved.gateway === details.pushNotifyUrl
        ? details.nativePushAppID
        : null,
    iosAppId: hasCompleteOverride(override)
      ? resolved.appId
      : details !== null && resolved.gateway === details.pushNotifyUrl
        ? (details.iosPushAppID ?? null)
        : null,
    unifiedPushGatewayUrl: details?.unifiedPushGatewayUrl ?? null,
    embeddedGatewayUrl: preferences.pushEmbeddedServerUrl.trim() || embeddedServer(details),
    provider,
    eventIdOnly: !preferences.richPushPayloads,
    userId: session?.user_id ?? null,
    deviceId: session?.device_id ?? null,
    accounts: accounts
      .filter((account) => !account.needs_reauth)
      .map((account) => ({ userId: account.user_id, deviceId: account.device_id })),
  });
}

const DISTRIBUTOR_KEY = 'sable.push.distributor';
const PROVIDER_KEY = 'sable.push.provider';
let pending: Promise<void> = Promise.resolve();

export function selectedPushDistributor(): string {
  return localStorage.getItem(DISTRIBUTOR_KEY) ?? '';
}

export function selectedPushProvider(): PushProvider {
  const value = localStorage.getItem(PROVIDER_KEY);
  return value === 'fcm' || value === 'unifiedpush' || value === 'embedded' || value === 'auto'
    ? value
    : 'auto';
}

function enqueue(operation: () => Promise<void>): Promise<void> {
  const result = pending.then(operation);
  pending = result.catch(() => undefined);
  return result;
}

let queuedRegistration: { key: string; result: Promise<void> } | null = null;

type PushRequest = {
  override: PushOverride;
  session: SessionInfo | null;
  accounts: readonly SessionInfo[];
};

const RETRY_DELAYS_MS = [15_000, 60_000, 300_000];
const RETRYABLE_STAGES = new Set(['platform', 'capabilities', 'homeserver']);
let wanted: PushRequest | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryAttempt = 0;

function cancelRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
}

function scheduleRetry(): void {
  const failure = lastPushFailure();
  if (!wanted || retryTimer !== undefined || !failure || !RETRYABLE_STAGES.has(failure.stage)) {
    return;
  }
  const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    void retryNativePushNow();
  }, delay);
}

export async function retryNativePushNow(): Promise<void> {
  const failure = lastPushFailure();
  if (!wanted || !failure || !RETRYABLE_STAGES.has(failure.stage)) return;
  cancelRetry();
  await registerNativePush(wanted.override, wanted.session, wanted.accounts).catch(() => undefined);
}

export function registerNativePush(
  override: PushOverride,
  session: SessionInfo | null,
  accounts: readonly SessionInfo[]
): Promise<void> {
  wanted = { override, session, accounts };
  const key = JSON.stringify([
    override,
    session?.user_id,
    session?.device_id,
    accounts.map((account) => [account.user_id, account.device_id, account.needs_reauth]),
    selectedPushProvider(),
    preferences.richPushPayloads,
    preferences.pushEmbeddedServerUrl,
  ]);
  if (queuedRegistration?.key === key) return queuedRegistration.result;
  const result = enqueue(async () => {
    try {
      await register(override, session, accounts);
      clearPushFailure();
      cancelRetry();
      retryAttempt = 0;
    } catch (error) {
      recordPushFailure(error);
      scheduleRetry();
      throw error;
    }
  });
  const entry = { key, result };
  queuedRegistration = entry;
  const settle = (): void => {
    if (queuedRegistration === entry) queuedRegistration = null;
  };
  result.then(settle, settle);
  return result;
}

export function unregisterNativePush(account?: NativePushAccount): Promise<void> {
  if (
    !account ||
    (wanted?.session?.user_id === account.user_id && wanted.session.device_id === account.device_id)
  ) {
    wanted = null;
    cancelRetry();
    retryAttempt = 0;
  } else if (wanted) {
    wanted = {
      ...wanted,
      accounts: wanted.accounts.filter(
        (candidate) =>
          candidate.user_id !== account.user_id || candidate.device_id !== account.device_id
      ),
    };
  }
  return enqueue(() => unregisterNativePushConfig(account));
}

export function switchPushProvider(
  provider: PushProvider,
  override: PushOverride,
  session: SessionInfo | null,
  accounts: readonly SessionInfo[]
): Promise<void> {
  return enqueue(async () => {
    if (!session) throw new Error('Sign in before changing the transport');
    const available = await listPushDistributors();
    const previousProvider = selectedPushProvider();
    const previousDistributor = selectedPushDistributor();
    let distributor = previousDistributor;
    try {
      if (provider === 'embedded') {
        distributor = 'embedded-websocket';
        if (!available.includes(distributor)) {
          throw new Error('Built-in distributor is unavailable');
        }
        await setPushDistributor(distributor);
      } else if (provider === 'unifiedpush') {
        if (
          !distributor ||
          distributor === 'embedded-websocket' ||
          !available.includes(distributor)
        ) {
          distributor = available.find((value) => value !== 'embedded-websocket') ?? '';
        }
        if (!distributor) throw new NoDistributorError();
        await setPushDistributor(distributor);
      }
      await register(override, session, accounts, provider);
      localStorage.setItem(PROVIDER_KEY, provider);
      if (distributor) localStorage.setItem(DISTRIBUTOR_KEY, distributor);
    } catch (error) {
      try {
        if (previousDistributor) await setPushDistributor(previousDistributor);
        await register(override, session, accounts, previousProvider);
      } catch (rollbackError) {
        console.warn('[sable notifications] restoring push provider failed', rollbackError);
        localStorage.removeItem(PROVIDER_KEY);
      }
      throw error;
    }
  });
}

export function switchPushDistributor(
  name: string,
  override: PushOverride,
  session: SessionInfo | null,
  accounts: readonly SessionInfo[]
): Promise<void> {
  return enqueue(async () => {
    if (!session) throw new Error('Sign in before changing the distributor');
    const available = await listPushDistributors();
    if (!available.includes(name)) throw new Error('Distributor is not available');
    const { resolved } = await pushConfig(override);
    if (!resolved) throw new PushConfigMissing();
    const previous = selectedPushDistributor();
    try {
      await setPushDistributor(name);
      await register(override, session, accounts);
      localStorage.setItem(DISTRIBUTOR_KEY, name);
    } catch (error) {
      if (previous && available.includes(previous)) {
        try {
          await setPushDistributor(previous);
          await register(override, session, accounts);
        } catch (restoreError) {
          localStorage.removeItem(DISTRIBUTOR_KEY);
          throw restoreError;
        }
      }
      throw error;
    }
  });
}
