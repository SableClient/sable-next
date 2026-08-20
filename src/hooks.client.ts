import * as Sentry from '@sentry/sveltekit';
import type { HandleClientError } from '@sveltejs/kit/hooks';

import { syncNativeTelemetryConsent } from '#lib/observability/native-consent.js';
import { sanitizePayload, scrubMatrixIds, scrubMatrixUrl } from '#lib/observability/scrubbers.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { CoreError } from '#src/transport';

const dsn = import.meta.env.VITE_SENTRY_DSN;
const environment = import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE;
const release = import.meta.env.VITE_APP_VERSION;
const sampleEverything = environment === 'development' || environment === 'preview';

const SESSION_ERROR_LIMIT = 50;
let sessionErrorCount = 0;

if (dsn && preferences.errorReporting) {
  Sentry.init({
    dsn,
    environment,
    release,

    dataCollection: { userInfo: false, httpBodies: [] },

    integrations: [
      Sentry.consoleLoggingIntegration({ levels: ['error', 'warn'] }),
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

    tracesSampleRate: sampleEverything ? 1 : 0.1,
    replaysSessionSampleRate: sampleEverything ? 1 : 0.1,
    replaysOnErrorSampleRate: 1,
    enableLogs: true,

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

    beforeSendTransaction(event) {
      if (event.transaction) event.transaction = scrubMatrixUrl(event.transaction);
      for (const span of event.spans ?? []) {
        if (span.description) span.description = scrubMatrixUrl(span.description);
        span.data = sanitizePayload(span.data) as typeof span.data;
      }
      return event;
    },

    beforeSend(event, hint) {
      sessionErrorCount += 1;
      if (sessionErrorCount > SESSION_ERROR_LIMIT) return null;

      // Every CoreError is thrown from the same line of the transport, so the
      // code is what separates "homeserver refused" from "core panicked".
      if (hint.originalException instanceof CoreError) {
        event.fingerprint = ['{{ default }}', hint.originalException.detail.code];
      }

      if (event.message) event.message = scrubMatrixIds(event.message);
      for (const exception of event.exception?.values ?? []) {
        if (exception.value) exception.value = scrubMatrixUrl(scrubMatrixIds(exception.value));
      }
      if (event.transaction) event.transaction = scrubMatrixUrl(event.transaction);
      if (event.contexts) {
        event.contexts = sanitizePayload(event.contexts) as typeof event.contexts;
      }
      if (event.request?.url) event.request.url = scrubMatrixUrl(event.request.url);
      return event;
    },
  });
}

// The native process has its own DSN baked in and drops everything until told.
syncNativeTelemetryConsent(preferences.errorReporting);

export const handleError: HandleClientError = (input) => {
  if (input.kind !== 'unknown') return;

  Sentry.captureException(input.error, {
    mechanism: {
      type: 'auto.function.sveltekit.handle_error',
      handled: false,
    },
  });
};
