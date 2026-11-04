import { isTauri, invoke } from '@tauri-apps/api/core';
import type { SessionInfo } from '#src/generated/protocol';

import { deliversNativePush } from './notifications.js';

export type NativePushAccount = Pick<SessionInfo, 'user_id' | 'device_id'>;

export interface NativePushConfig {
  gatewayUrl: string;
  gatewayOverride?: boolean;
  vapidKey: string;
  webAppId: string;
  nativeAppId: string | null;
  iosAppId?: string | null;
  unifiedPushGatewayUrl?: string | null;
  embeddedGatewayUrl?: string | null;
  provider?: 'auto' | 'fcm' | 'unifiedpush' | 'embedded';
  eventIdOnly: boolean;
  userId: string | null;
  deviceId: string | null;
  accounts: readonly { userId: string; deviceId: string }[];
}

export async function registerNativePushConfig(config: NativePushConfig): Promise<void> {
  if (!deliversNativePush()) return;

  await invoke('register_push', {
    config: {
      gateway_url: config.gatewayUrl,
      gateway_override: config.gatewayOverride ?? false,
      vapid_key: config.vapidKey,
      web_app_id: config.webAppId,
      native_app_id: config.nativeAppId,
      ios_app_id: config.iosAppId ?? null,
      unified_push_gateway_url: config.unifiedPushGatewayUrl ?? null,
      embedded_gateway_url: config.embeddedGatewayUrl ?? null,
      provider: config.provider ?? 'auto',
      event_id_only: config.eventIdOnly,
      user_id: config.userId,
      device_id: config.deviceId,
      accounts: config.accounts.map((account) => ({
        user_id: account.userId,
        device_id: account.deviceId,
      })),
    },
  });
}

export async function unregisterNativePushConfig(account?: NativePushAccount): Promise<void> {
  if (!deliversNativePush()) return;

  await invoke(
    'unregister_push',
    account ? { userId: account.user_id, deviceId: account.device_id } : undefined
  );
}

export async function supportsPushDistributors(): Promise<boolean> {
  if (!isTauri()) return false;
  const { type } = await import('@tauri-apps/plugin-os');
  return type() === 'android';
}

export async function listPushDistributors(): Promise<string[]> {
  if (!(await supportsPushDistributors())) return [];
  return invoke<string[]>('plugin:notifications|list_distributors');
}

export async function setPushDistributor(name: string): Promise<void> {
  await invoke('plugin:notifications|set_distributor', { name });
}
