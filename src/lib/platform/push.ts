import { isTauri, invoke } from '@tauri-apps/api/core';

import { deliversNativePush } from './notifications.js';

export interface NativePushConfig {
  gatewayUrl: string;
  vapidKey: string;
  webAppId: string;
  nativeAppId: string | null;
  iosAppId?: string | null;
  unifiedPushGatewayUrl?: string | null;
  embeddedGatewayUrl?: string | null;
  eventIdOnly: boolean;
  userId: string | null;
  deviceId: string | null;
}

export async function registerNativePushConfig(config: NativePushConfig): Promise<void> {
  if (!(await deliversNativePush())) return;

  await invoke('register_push', {
    config: {
      gateway_url: config.gatewayUrl,
      vapid_key: config.vapidKey,
      web_app_id: config.webAppId,
      native_app_id: config.nativeAppId,
      ios_app_id: config.iosAppId ?? null,
      unified_push_gateway_url: config.unifiedPushGatewayUrl ?? null,
      embedded_gateway_url: config.embeddedGatewayUrl ?? null,
      event_id_only: config.eventIdOnly,
      user_id: config.userId,
      device_id: config.deviceId,
    },
  });
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
