import { deliversNativePush } from '#lib/platform/notifications.js';
import { registerNativePushConfig } from '#lib/platform/push.js';

import { pushConfig, type PushOverride } from './push-config';

export async function registerNativePush(override: PushOverride): Promise<void> {
  if (!(await deliversNativePush())) return;

  const { resolved, details } = await pushConfig(override);
  if (!resolved) return;

  await registerNativePushConfig({
    gatewayUrl: resolved.gateway,
    vapidKey: resolved.vapid,
    webAppId: resolved.appId,
    nativeAppId:
      details !== null && resolved.gateway === details.pushNotifyUrl
        ? details.nativePushAppID
        : null,
  });
}
