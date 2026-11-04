import * as Sentry from '@sentry/sveltekit';
import { CoreError } from '#src/transport';
import { isTauri } from '@tauri-apps/api/core';

const LAST_RUN_VERSION_KEY = 'sable.lastRunVersion';

const launchedAfterUpdate = (() => {
  const current = import.meta.env.VITE_APP_VERSION ?? 'dev';
  try {
    const previous = localStorage.getItem(LAST_RUN_VERSION_KEY);
    localStorage.setItem(LAST_RUN_VERSION_KEY, current);
    return previous !== null && previous !== current;
  } catch {
    return false;
  }
})();

export function reportSessionFailure(
  operation:
    | 'restore'
    | 'restore_fallback'
    | 'restore_slow'
    | 'switch'
    | 'switch_slow'
    | 'session_ended',
  error?: unknown,
  reason?: string
): void {
  if (!Sentry.isInitialized()) return;
  const detail = error instanceof CoreError ? error.detail : undefined;
  if (detail?.code === 'failed' && detail.log_id.startsWith('core panicked:')) return;
  const tags = {
    'session.operation': operation,
    'session.reason':
      operation === 'session_ended'
        ? reason === 'soft_logout' || reason === 'token_rejected'
          ? reason
          : 'unknown'
        : operation === 'restore_slow' || operation === 'switch_slow'
          ? 'slow'
          : (detail?.code ?? 'transport_failure'),
    'session.after_update': String(launchedAfterUpdate),
    runtime: isTauri() ? 'native' : 'web',
  };
  const logId = detail?.code === 'failed' ? detail.log_id : undefined;
  Sentry.captureMessage(`session.${operation}`, {
    level:
      operation === 'session_ended' || operation === 'restore_slow' || operation === 'switch_slow'
        ? 'warning'
        : 'error',
    fingerprint: ['session', operation, tags['session.reason']],
    tags,
    extra: logId ? { log_id: logId } : undefined,
  });
}
