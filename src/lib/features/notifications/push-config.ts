import { type PushDetails, runtimeConfig } from '$lib/config/runtime-config';
import { type Preferences, preferences } from '$lib/settings/preferences.svelte';

export type PushConfig = {
  gateway: string;
  appId: string;
  vapid: string;
};

export type PushOverride = Pick<Preferences, 'pushGatewayUrl' | 'pushVapidKey' | 'pushAppId'>;

/** Called synchronously inside an effect, which is the only place these reads
    are tracked; the carriers then take the result as an argument. */
export function pushOverride(): PushOverride {
  return {
    pushGatewayUrl: preferences.pushGatewayUrl,
    pushVapidKey: preferences.pushVapidKey,
    pushAppId: preferences.pushAppId,
  };
}

function trimmed(override: PushOverride): PushConfig {
  return {
    gateway: override.pushGatewayUrl.trim(),
    appId: override.pushAppId.trim(),
    vapid: override.pushVapidKey.trim(),
  };
}

/** A gateway serves only the app id and VAPID keypair its own configuration
    names, so a partial override would register a pusher it cannot serve. */
export function hasCompleteOverride(override: PushOverride): boolean {
  const { gateway, appId, vapid } = trimmed(override);
  return gateway !== '' && appId !== '' && vapid !== '';
}

export function hasPartialOverride(override: PushOverride): boolean {
  const { gateway, appId, vapid } = trimmed(override);
  return [gateway, appId, vapid].some((value) => value !== '') && !hasCompleteOverride(override);
}

/** Mirrors `gateway()` in the core, which is what actually refuses to hand a
    device token to a non-gateway; this only explains the refusal. */
const GATEWAY_PATH = '/_matrix/push/v1/notify';

export type OverrideProblem = 'incomplete' | 'notAUrl' | 'notAGateway';

export function overrideProblem(override: PushOverride): OverrideProblem | null {
  const { gateway } = trimmed(override);
  // An empty override asks for the shipped default.
  if (!hasCompleteOverride(override)) {
    return hasPartialOverride(override) ? 'incomplete' : null;
  }

  let parsed: URL;
  try {
    parsed = new URL(gateway);
  } catch {
    return 'notAUrl';
  }

  const addressed = parsed.username !== '' || parsed.password !== '';
  if (parsed.protocol !== 'https:' || addressed || parsed.hash !== '') return 'notAGateway';
  return parsed.pathname === GATEWAY_PATH ? null : 'notAGateway';
}

export function resolvePushConfig(
  override: PushOverride,
  details: PushDetails | null
): PushConfig | null {
  if (hasCompleteOverride(override)) return trimmed(override);

  if (!details) return null;
  return {
    gateway: details.pushNotifyUrl,
    appId: details.webPushAppID,
    vapid: details.vapidPublicKey,
  };
}

export async function pushConfig(
  override: PushOverride
): Promise<{ resolved: PushConfig | null; details: PushDetails | null }> {
  const { push } = await runtimeConfig();
  return { resolved: resolvePushConfig(override, push), details: push };
}
