import * as Sentry from '@sentry/sveltekit';
import { CoreError } from '#src/transport';
import { isTauri } from '@tauri-apps/api/core';

export function reportSessionFailure(
  operation: 'restore' | 'restore_fallback' | 'session_ended',
  error?: unknown,
  reason?: string
): void {
  if (!Sentry.isInitialized()) return;
  const detail = error instanceof CoreError ? error.detail : undefined;
  const tags = {
    'session.operation': operation,
    'session.reason':
      operation === 'session_ended'
        ? reason === 'soft_logout' || reason === 'token_rejected'
          ? reason
          : 'unknown'
        : (detail?.code ?? 'transport_failure'),
    runtime: isTauri() ? 'native' : 'web',
  };
  const logId = detail?.code === 'failed' ? detail.log_id : undefined;
  Sentry.captureMessage(`session.${operation}`, {
    level: operation === 'session_ended' ? 'warning' : 'error',
    fingerprint: ['session', operation, tags['session.reason']],
    tags,
    extra: logId ? { log_id: logId } : undefined,
  });
}
