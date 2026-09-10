import type { SessionInfo } from '#src/generated/protocol';

import { deliversNativePush } from '#lib/platform/notifications.js';
import {
  registerNativePushConfig,
  unregisterNativePushConfig,
  listPushDistributors,
  setPushDistributor,
} from '#lib/platform/push.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { pushConfig, type PushOverride } from './push-config';

export type PushProvider = 'auto' | 'fcm' | 'unifiedpush' | 'embedded';

async function register(
  override: PushOverride,
  session: SessionInfo | null,
  provider: PushProvider = selectedPushProvider()
): Promise<void> {
  if (!(await deliversNativePush())) return;

  const { resolved, details } = await pushConfig(override);
  if (!resolved) throw new Error('Push gateway is not configured');

  await registerNativePushConfig({
    gatewayUrl: resolved.gateway,
    vapidKey: resolved.vapid,
    webAppId: resolved.appId,
    nativeAppId:
      details !== null && resolved.gateway === details.pushNotifyUrl
        ? details.nativePushAppID
        : null,
    iosAppId:
      details !== null && resolved.gateway === details.pushNotifyUrl
        ? (details.iosPushAppID ?? null)
        : null,
    unifiedPushGatewayUrl: details?.unifiedPushGatewayUrl ?? null,
    embeddedGatewayUrl: details?.unifiedPushEmbeddedServerUrl ?? 'https://ntfy.sh',
    provider,
    eventIdOnly: !preferences.richPushPayloads,
    userId: session?.user_id ?? null,
    deviceId: session?.device_id ?? null,
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

export function registerNativePush(
  override: PushOverride,
  session: SessionInfo | null
): Promise<void> {
  return enqueue(() => register(override, session));
}

export function unregisterNativePush(): Promise<void> {
  return enqueue(() => unregisterNativePushConfig());
}

export function switchPushProvider(
  provider: PushProvider,
  override: PushOverride,
  session: SessionInfo | null
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
        if (!distributor) throw new Error('No UnifiedPush distributor is available');
        await setPushDistributor(distributor);
      }
      await register(override, session, provider);
      localStorage.setItem(PROVIDER_KEY, provider);
      if (distributor) localStorage.setItem(DISTRIBUTOR_KEY, distributor);
    } catch (error) {
      try {
        if (previousDistributor) await setPushDistributor(previousDistributor);
        await register(override, session, previousProvider);
      } catch {
        localStorage.removeItem(PROVIDER_KEY);
      }
      throw error;
    }
  });
}

export function switchPushDistributor(
  name: string,
  override: PushOverride,
  session: SessionInfo | null
): Promise<void> {
  return enqueue(async () => {
    if (!session) throw new Error('Sign in before changing the distributor');
    const available = await listPushDistributors();
    if (!available.includes(name)) throw new Error('Distributor is not available');
    const { resolved } = await pushConfig(override);
    if (!resolved) throw new Error('Push gateway is not configured');
    const previous = selectedPushDistributor();
    try {
      await setPushDistributor(name);
      await register(override, session);
      localStorage.setItem(DISTRIBUTOR_KEY, name);
    } catch (error) {
      if (previous && available.includes(previous)) {
        try {
          await setPushDistributor(previous);
          await register(override, session);
        } catch (restoreError) {
          localStorage.removeItem(DISTRIBUTOR_KEY);
          throw restoreError;
        }
      }
      throw error;
    }
  });
}
