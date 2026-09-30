import { BrowserClient, defaultStackParser, makeFetchTransport } from '@sentry/sveltekit';

import { telemetryConsent } from '#lib/features/notifications/room-names.js';
import { scrubSentryEvent } from '#lib/observability/sentry-event.js';

let client: BrowserClient | undefined;
const environment = import.meta.env as {
  VITE_SENTRY_DSN?: string;
  VITE_SENTRY_ENVIRONMENT?: string;
  VITE_APP_VERSION?: string;
  MODE: string;
};

export async function reportWorkerError(operation: string, error: unknown): Promise<void> {
  const dsn = environment.VITE_SENTRY_DSN;
  if (!dsn || !(await telemetryConsent())) return;

  client ??= new BrowserClient({
    dsn,
    environment: environment.VITE_SENTRY_ENVIRONMENT ?? environment.MODE,
    release: environment.VITE_APP_VERSION,
    integrations: [],
    stackParser: defaultStackParser,
    transport: makeFetchTransport,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpBodies: [],
      httpHeaders: false,
      urlQueryParams: false,
    },
    beforeSend: async (event) => ((await telemetryConsent()) ? scrubSentryEvent(event) : null),
  });
  client.captureException(error, {
    mechanism: { type: 'auto.service_worker', handled: false },
    captureContext: {
      tags: { source: 'service-worker', operation },
    },
  });
  await client.flush(2000);
}

export async function watchWorkerOperation<T>(operation: string, pending: Promise<T>): Promise<T> {
  try {
    return await pending;
  } catch (error) {
    await reportWorkerError(operation, error).catch(() => undefined);
    throw error;
  }
}
