import * as Sentry from '@sentry/sveltekit';
import type { HandleClientError } from '@sveltejs/kit/hooks';

import { tolerateUnknownListeners } from '#lib/platform/tauri-events.js';
import { syncTelemetryConsent } from '#lib/platform/telemetry.js';
import {
  installDynamicImportRecovery,
  recoverStaleDynamicImport,
} from '#lib/observability/dynamic-import-recovery.js';
import { sanitizePayload, scrubMatrixIds, scrubMatrixUrl } from '#lib/observability/scrubbers.js';
import { scrubSentryEvent } from '#lib/observability/sentry-event.js';
import { untrackFetch } from '#lib/observability/untracked-fetch.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { CoreError } from '#src/transport';

const dsn = import.meta.env.VITE_SENTRY_DSN;
const environment = import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE;
const release = import.meta.env.VITE_APP_VERSION;
const sampleEverything = environment === 'development' || environment === 'preview';

installDynamicImportRecovery();
tolerateUnknownListeners();

if (dsn && preferences.errorReporting) {
  Sentry.init({
    dsn,
    environment,
    release,

    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: {
        request: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
        response: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
      },
      httpBodies: [],
      urlQueryParams: { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
    },

    integrations: [
      Sentry.consoleLoggingIntegration({ levels: ['error', 'warn'] }),
      Sentry.captureConsoleIntegration({ levels: ['error'] }),
      ...(preferences.sessionReplay
        ? [
            Sentry.replayIntegration({
              maskAllText: true,
              maskAllInputs: true,
              blockAllMedia: true,
            }),
          ]
        : []),
    ],

    tracesSampler(context) {
      if (context.name.startsWith('call.')) return 1;
      return context.inheritOrSampleWith(sampleEverything ? 1 : 0.1);
    },
    replaysSessionSampleRate: sampleEverything ? 1 : 0.1,
    replaysOnErrorSampleRate: 1,

    beforeSendLog(log) {
      if (log.level === 'debug' && environment === 'production') return null;
      if (typeof log.message === 'string') log.message = scrubMatrixIds(log.message);
      if (log.attributes) {
        log.attributes = sanitizePayload(log.attributes) as typeof log.attributes;
      }
      return log;
    },

    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.message) breadcrumb.message = scrubMatrixIds(breadcrumb.message);
      if (breadcrumb.data) {
        breadcrumb.data = sanitizePayload(breadcrumb.data) as typeof breadcrumb.data;
      }
      return breadcrumb;
    },

    beforeSendSpan(span) {
      span.name = scrubMatrixUrl(span.name);
      span.attributes = sanitizePayload(span.attributes) as typeof span.attributes;
      return span;
    },

    beforeSend(event, hint) {
      if (hint.originalException instanceof CoreError) {
        event.fingerprint = ['{{ default }}', hint.originalException.detail.code];
      }

      return scrubSentryEvent(event);
    },
  });
  untrackFetch(window);
}

syncTelemetryConsent(preferences.errorReporting);

export const handleError: HandleClientError = (input) => {
  if (input.kind !== 'unknown') return;
  if (recoverStaleDynamicImport(input.error)) return;

  const eventId = Sentry.captureException(input.error, {
    mechanism: {
      type: 'auto.function.sveltekit.handle_error',
      handled: false,
    },
  });
  console.error('[sable] unhandled error', input.error);

  const error = input.error instanceof Error ? input.error : undefined;
  return {
    message: error?.message ?? String(input.error),
    stack: error?.stack,
    eventId: Sentry.isInitialized() ? eventId : undefined,
  };
};
