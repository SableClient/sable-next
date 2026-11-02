import type { DiagnosticPushView, RegisteredPusherView } from '#src/generated/protocol';
import type { PushPlatform } from '#lib/platform/notifications.js';

import { describePushFailure, type PushFailure } from './push-failure';
import type { PushHistoryEntry } from '#lib/notifications/push-history.js';

export type TroubleshootCheck =
  | 'permission'
  | 'alerts'
  | 'transport'
  | 'background'
  | 'alarms'
  | 'pusher'
  | 'gateway'
  | 'loopback';

export type TroubleshootState = 'pass' | 'fail' | 'warn' | 'skip';

export type TroubleshootAction = 'allowBackground' | 'allowAlarms';

export interface TroubleshootResult {
  check: TroubleshootCheck;
  state: TroubleshootState;
  message: string;
  params?: Record<string, string>;
  action?: TroubleshootAction;
  detail?: { message: string; params: Record<string, string> };
}

export interface PushTransportInfo {
  provider: string | null;
  distributor: string | null;
}

export interface TroubleshootDeps {
  platform: PushPlatform;
  webPushSupported: boolean;
  permissionGranted: () => Promise<boolean>;
  alertsEnabled: () => boolean;
  nativeTransport: () => Promise<PushTransportInfo | null>;
  ignoringBatteryOptimizations: () => Promise<boolean | null>;
  canScheduleExactAlarms: () => Promise<boolean | null>;
  ownPushkey: () => Promise<string | null>;
  pushers: () => Promise<RegisteredPusherView[]>;
  pingGateway: (url: string) => Promise<boolean | null>;
  sendDiagnostic: (pushkey: string, appId: string) => Promise<DiagnosticPushView>;
  history: () => Promise<PushHistoryEntry[]>;
  registrationFailure: () => PushFailure | null;
  reactivate: (() => Promise<void>) | null;
  wait: (ms: number) => Promise<void>;
}

export const LOOPBACK_TIMEOUT_MS = 30_000;
const ACTIVATION_TIMEOUT_MS = 30_000;
const LOOPBACK_POLL_MS = 1_000;

const PUSH_CHECKS: TroubleshootCheck[] = ['transport', 'pusher', 'gateway', 'loopback'];

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function withFailure(deps: TroubleshootDeps, result: TroubleshootResult): TroubleshootResult {
  const failure = deps.registrationFailure();
  return failure === null ? result : { ...result, detail: describePushFailure(failure) };
}

function skipped(from: TroubleshootCheck, message: string): TroubleshootResult[] {
  return PUSH_CHECKS.slice(PUSH_CHECKS.indexOf(from)).map((check) => ({
    check,
    state: 'skip',
    message,
  }));
}

async function transport(deps: TroubleshootDeps): Promise<TroubleshootResult> {
  if (deps.platform === 'web') {
    return deps.webPushSupported
      ? { check: 'transport', state: 'pass', message: 'settings.troubleshootTransportWeb' }
      : { check: 'transport', state: 'fail', message: 'settings.troubleshootTransportUnsupported' };
  }
  if (deps.platform === 'ios') {
    return (await deps.ownPushkey()) === null
      ? withFailure(deps, {
          check: 'transport',
          state: 'fail',
          message: 'settings.troubleshootTransportAppleNoToken',
        })
      : { check: 'transport', state: 'pass', message: 'settings.troubleshootTransportApple' };
  }
  const native = await deps.nativeTransport();
  if (native?.provider == null) {
    return { check: 'transport', state: 'fail', message: 'settings.troubleshootTransportNone' };
  }
  return {
    check: 'transport',
    state: 'pass',
    message: 'settings.troubleshootTransportNative',
    params: { provider: native.provider, distributor: native.distributor ?? native.provider },
  };
}

async function background(deps: TroubleshootDeps, embedded: boolean): Promise<TroubleshootResult> {
  const ignoring = await deps.ignoringBatteryOptimizations();
  if (ignoring === null) {
    return {
      check: 'background',
      state: 'skip',
      message: 'settings.troubleshootBackgroundUnknown',
    };
  }
  if (ignoring) {
    return {
      check: 'background',
      state: 'pass',
      message: 'settings.troubleshootBackgroundAllowed',
    };
  }
  return {
    check: 'background',
    state: embedded ? 'fail' : 'warn',
    message: embedded
      ? 'settings.troubleshootBackgroundRequired'
      : 'settings.troubleshootBackgroundRecommended',
    action: 'allowBackground',
  };
}

async function alarms(deps: TroubleshootDeps): Promise<TroubleshootResult> {
  const allowed = await deps.canScheduleExactAlarms();
  if (allowed === null) {
    return { check: 'alarms', state: 'skip', message: 'settings.troubleshootAlarmsUnknown' };
  }
  return allowed
    ? { check: 'alarms', state: 'pass', message: 'settings.troubleshootAlarmsAllowed' }
    : {
        check: 'alarms',
        state: 'warn',
        message: 'settings.troubleshootAlarmsDenied',
        action: 'allowAlarms',
      };
}

export async function* troubleshootBackground(
  deps: TroubleshootDeps
): AsyncGenerator<TroubleshootResult> {
  if (deps.platform !== 'android') {
    yield { check: 'background', state: 'skip', message: 'settings.troubleshootAndroidOnly' };
    yield { check: 'alarms', state: 'skip', message: 'settings.troubleshootAndroidOnly' };
    return;
  }
  const embedded = (await deps.nativeTransport())?.provider === 'embedded';
  yield await background(deps, embedded);
  yield embedded
    ? await alarms(deps)
    : { check: 'alarms', state: 'skip', message: 'settings.troubleshootAlarmsEmbeddedOnly' };
}

async function awaitDiagnostic(deps: TroubleshootDeps, eventId: string): Promise<boolean> {
  for (let waited = 0; waited <= LOOPBACK_TIMEOUT_MS; waited += LOOPBACK_POLL_MS) {
    const history = await deps.history();
    if (history.some((entry) => entry.eventId === eventId)) return true;
    await deps.wait(LOOPBACK_POLL_MS);
  }
  return false;
}

async function reactivated(
  deps: TroubleshootDeps,
  pushkey: string
): Promise<RegisteredPusherView | null> {
  if (deps.reactivate === null) return null;
  try {
    await deps.reactivate();
    for (let waited = 0; waited <= ACTIVATION_TIMEOUT_MS; waited += LOOPBACK_POLL_MS) {
      const pusher = (await deps.pushers()).find((candidate) => candidate.pushkey === pushkey);
      if (pusher === undefined) return null;
      if (pusher.activated !== false) return pusher;
      await deps.wait(LOOPBACK_POLL_MS);
    }
  } catch (error) {
    console.warn('[sable notifications] reactivating the pusher failed', error);
  }
  return null;
}

async function loopback(
  deps: TroubleshootDeps,
  pusher: RegisteredPusherView
): Promise<TroubleshootResult> {
  if (deps.platform === 'ios') {
    return {
      check: 'loopback',
      state: 'skip',
      message: 'settings.troubleshootLoopbackUnsupported',
    };
  }
  let push: DiagnosticPushView;
  try {
    push = await deps.sendDiagnostic(pusher.pushkey, pusher.app_id);
  } catch (error) {
    console.warn('[sable notifications] diagnostic push failed', error);
    return { check: 'loopback', state: 'fail', message: 'settings.troubleshootLoopbackFailed' };
  }
  switch (push.kind) {
    case 'no_pusher':
      return { check: 'loopback', state: 'fail', message: 'settings.troubleshootPusherMissing' };
    case 'no_gateway':
      return {
        check: 'loopback',
        state: 'skip',
        message: 'settings.troubleshootLoopbackHomeserver',
      };
    case 'refused':
      return {
        check: 'loopback',
        state: 'skip',
        message: 'settings.troubleshootLoopbackRefused',
      };
    case 'rejected':
      return { check: 'loopback', state: 'fail', message: 'settings.troubleshootLoopbackRejected' };
    case 'unforwarded':
      return {
        check: 'loopback',
        state: 'fail',
        message: 'settings.troubleshootLoopbackUnforwarded',
        params: { host: host(pusher.gateway ?? '') },
      };
    case 'sent':
      return (await awaitDiagnostic(deps, push.event_id))
        ? { check: 'loopback', state: 'pass', message: 'settings.troubleshootLoopbackReceived' }
        : { check: 'loopback', state: 'fail', message: 'settings.troubleshootLoopbackMissing' };
  }
}

export async function* troubleshoot(deps: TroubleshootDeps): AsyncGenerator<TroubleshootResult> {
  yield (await deps.permissionGranted())
    ? { check: 'permission', state: 'pass', message: 'settings.troubleshootPermissionGranted' }
    : { check: 'permission', state: 'fail', message: 'settings.troubleshootPermissionDenied' };

  yield deps.alertsEnabled()
    ? { check: 'alerts', state: 'pass', message: 'settings.troubleshootAlertsOn' }
    : { check: 'alerts', state: 'fail', message: 'settings.troubleshootAlertsOff' };

  if (deps.platform === 'desktop') {
    yield* skipped('transport', 'settings.troubleshootDesktop');
    return;
  }

  const carried = await transport(deps);
  yield carried;
  yield* troubleshootBackground(deps);
  if (carried.state === 'fail') {
    yield* skipped('pusher', 'settings.troubleshootNotApplicable');
    return;
  }

  const pushkey = await deps.ownPushkey();
  if (pushkey === null) {
    yield withFailure(deps, {
      check: 'pusher',
      state: 'fail',
      message: 'settings.troubleshootPusherNone',
    });
    yield* skipped('gateway', 'settings.troubleshootNotApplicable');
    return;
  }
  let pushers: RegisteredPusherView[];
  try {
    pushers = await deps.pushers();
  } catch (error) {
    console.warn('[sable notifications] reading pushers failed', error);
    yield { check: 'pusher', state: 'fail', message: 'settings.troubleshootPusherUnreadable' };
    yield* skipped('gateway', 'settings.troubleshootNotApplicable');
    return;
  }
  let pusher = pushers.find((candidate) => candidate.pushkey === pushkey);
  if (pusher === undefined) {
    yield withFailure(deps, {
      check: 'pusher',
      state: 'fail',
      message: 'settings.troubleshootPusherMissing',
    });
    yield* skipped('gateway', 'settings.troubleshootNotApplicable');
    return;
  }
  if (pusher.activated === false) {
    const activated = await reactivated(deps, pushkey);
    if (activated === null) {
      yield withFailure(deps, {
        check: 'pusher',
        state: 'fail',
        message: 'settings.troubleshootPusherInactive',
      });
      yield* skipped('gateway', 'settings.troubleshootNotApplicable');
      return;
    }
    pusher = activated;
  }
  const gateway = pusher.gateway;
  yield {
    check: 'pusher',
    state: 'pass',
    message:
      gateway === null
        ? 'settings.troubleshootPusherHomeserver'
        : 'settings.troubleshootPusherGateway',
    params: gateway === null ? {} : { host: host(gateway) },
  };

  if (gateway === null) {
    yield pusher.activated === true && pusher.endpoint !== null
      ? {
          check: 'gateway',
          state: 'pass',
          message: 'settings.troubleshootGatewayActivated',
          params: { host: host(pusher.endpoint) },
        }
      : { check: 'gateway', state: 'skip', message: 'settings.troubleshootGatewayHomeserver' };
  } else {
    const reached = await deps.pingGateway(gateway);
    const params = { host: host(gateway) };
    yield reached === true
      ? { check: 'gateway', state: 'pass', message: 'settings.troubleshootGatewayReached', params }
      : reached === false
        ? {
            check: 'gateway',
            state: 'fail',
            message: 'settings.troubleshootGatewayUnreachable',
            params,
          }
        : {
            check: 'gateway',
            state: 'warn',
            message: 'settings.troubleshootGatewayUnknown',
            params,
          };
  }

  yield await loopback(deps, pusher);
}
