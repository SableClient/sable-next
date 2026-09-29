type PlainStage = 'no_session' | 'capabilities' | 'no_gateway' | 'no_app_id' | 'ledger';

export type PushFailure =
  | { stage: PlainStage | 'config' }
  | { stage: 'platform'; message: string }
  | { stage: 'homeserver'; code: string };

const PLAIN_STAGES = new Set<unknown>([
  'no_session',
  'capabilities',
  'no_gateway',
  'no_app_id',
  'ledger',
]);

let last: PushFailure | null = null;

export class PushConfigMissing extends Error {
  constructor() {
    super('Push gateway is not configured');
  }
}

function codeOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const { code } = value as { code?: unknown };
  return typeof code === 'string' ? code : null;
}

export function readPushFailure(error: unknown): PushFailure {
  if (error !== null && typeof error === 'object' && 'stage' in error) {
    const failure = error as { stage?: unknown; message?: unknown; error?: unknown };
    if (failure.stage === 'platform' && typeof failure.message === 'string') {
      return { stage: 'platform', message: failure.message };
    }
    if (failure.stage === 'homeserver') {
      return { stage: 'homeserver', code: codeOf(failure.error) ?? 'unknown' };
    }
    if (PLAIN_STAGES.has(failure.stage)) return { stage: failure.stage as PlainStage };
  }
  const code = codeOf(error);
  if (code !== null) return { stage: 'homeserver', code };
  if (error instanceof PushConfigMissing) return { stage: 'config' };
  return { stage: 'platform', message: error instanceof Error ? error.message : String(error) };
}

export function recordPushFailure(error: unknown): void {
  last = readPushFailure(error);
}

export function clearPushFailure(): void {
  last = null;
}

export function lastPushFailure(): PushFailure | null {
  return last;
}

export function describePushFailure(failure: PushFailure): {
  message: string;
  params: Record<string, string>;
} {
  switch (failure.stage) {
    case 'platform':
      return {
        message: 'settings.troubleshootFailurePlatform',
        params: { message: failure.message },
      };
    case 'homeserver':
      return { message: 'settings.troubleshootFailureHomeserver', params: { code: failure.code } };
    case 'no_session':
      return { message: 'settings.troubleshootFailureNoSession', params: {} };
    case 'capabilities':
      return { message: 'settings.troubleshootFailureCapabilities', params: {} };
    case 'no_gateway':
      return { message: 'settings.troubleshootFailureNoGateway', params: {} };
    case 'no_app_id':
      return { message: 'settings.troubleshootFailureNoAppId', params: {} };
    case 'ledger':
      return { message: 'settings.troubleshootFailureLedger', params: {} };
    case 'config':
      return { message: 'settings.troubleshootFailureConfig', params: {} };
  }
}
