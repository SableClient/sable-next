import type { SessionInfo } from '#src/generated/protocol';

import { runtimeConfig } from '#lib/config/runtime-config.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { nativeVoipToken } from '#lib/platform/calls.js';

import { pusherDisplayName } from './web-push';

const REGISTERED_KEY = 'sable.push.voip';

interface Registered {
  userId: string;
  appId: string;
  pushkey: string;
  deviceDisplayName: string;
}

function registered(): Registered | null {
  try {
    const value = JSON.parse(localStorage.getItem(REGISTERED_KEY) ?? 'null') as Registered | null;
    return value && typeof value.pushkey === 'string' ? value : null;
  } catch {
    return null;
  }
}

export async function unregisterVoipPusher(core: CoreClient): Promise<void> {
  const previous = registered();
  if (!previous) return;
  await core.commands.removePusher(previous.pushkey, previous.appId).catch(() => undefined);
  localStorage.removeItem(REGISTERED_KEY);
}

export async function registerVoipPusher(
  core: CoreClient,
  session: SessionInfo | null,
  token?: string
): Promise<void> {
  const details = (await runtimeConfig()).push;
  const appId = details?.iosVoipPushAppID ?? null;
  const pushkey = token ?? (await nativeVoipToken());
  if (!details || !appId || !pushkey || !session) return;

  const previous = registered();
  const deviceDisplayName = pusherDisplayName(core);
  const samePusher =
    previous?.userId === session.user_id &&
    previous.appId === appId &&
    previous.pushkey === pushkey;
  if (samePusher && previous.deviceDisplayName === deviceDisplayName) {
    return;
  }
  if (previous && !samePusher) await unregisterVoipPusher(core);

  await core.commands.setPusher({
    pushkey,
    app_id: appId,
    url: details.pushNotifyUrl,
    device_display_name: deviceDisplayName,
    web_push: null,
    event_id_only: false,
    append: true,
  });
  localStorage.setItem(
    REGISTERED_KEY,
    JSON.stringify({
      userId: session.user_id,
      appId,
      pushkey,
      deviceDisplayName,
    } satisfies Registered)
  );
}
