import { invoke } from '@tauri-apps/api/core';

import { deliversNativePush } from './notifications.js';

export interface NativePushConfig {
  gatewayUrl: string;
  vapidKey: string;
  webAppId: string;
  nativeAppId: string | null;
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
      event_id_only: config.eventIdOnly,
      user_id: config.userId,
      device_id: config.deviceId,
    },
  });
}
