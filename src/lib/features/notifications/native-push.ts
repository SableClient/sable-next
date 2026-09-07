import type { SessionInfo } from '#src/generated/protocol';

import { deliversNativePush } from '#lib/platform/notifications.js';
import {
  registerNativePushConfig,
  listPushDistributors,
  setPushDistributor,
} from '#lib/platform/push.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { pushConfig, type PushOverride } from './push-config';

async function register(override: PushOverride, session: SessionInfo | null): Promise<void> {
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
    eventIdOnly: !preferences.richPushPayloads,
    userId: session?.user_id ?? null,
    deviceId: session?.device_id ?? null,
  });
}

const DISTRIBUTOR_KEY = 'sable.push.distributor';
let pending: Promise<void> = Promise.resolve();

export function selectedPushDistributor(): string {
  return localStorage.getItem(DISTRIBUTOR_KEY) ?? '';
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
