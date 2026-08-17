import { invoke, isTauri } from '@tauri-apps/api/core';

import { pushConfig, type PushOverride } from './push-config';

export async function registerNativePush(override: PushOverride): Promise<void> {
  if (!isTauri()) return;

  const { resolved, details } = await pushConfig(override);
  if (!resolved) return;

  // Only the deployment names an app id a token distributor can register under.
  const nativeAppId =
    details !== null && resolved.gateway === details.pushNotifyUrl ? details.nativePushAppID : null;

  await invoke('register_push', {
    config: {
      gateway_url: resolved.gateway,
      vapid_key: resolved.vapid,
      web_app_id: resolved.appId,
      native_app_id: nativeAppId,
    },
  });
}
