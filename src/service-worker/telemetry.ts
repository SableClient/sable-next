import { BrowserClient, defaultStackParser, makeFetchTransport } from '@sentry/sveltekit';

import { telemetryConsent } from '#lib/notifications/room-names.js';
import { scrubSentryEvent } from '#lib/observability/sentry-event.js';

let client: BrowserClient | undefined;
const environment = import.meta.env as {
  VITE_SENTRY_DSN?: string;
  VITE_SENTRY_ENVIRONMENT?: string;
  VITE_APP_VERSION?: string;
  MODE: string;
};

/** A newer deploy removed this worker's assets, and the worker replacing it is on its way. */
export class StaleWorkerError extends Error {
  constructor(options?: ErrorOptions) {
    super('a newer service worker replaces this one', options);
    this.name = 'StaleWorkerError';
  }
}

export async function reportWorkerError(operation: string, error: unknown): Promise<void> {
  const dsn = environment.VITE_SENTRY_DSN;
  if (error instanceof StaleWorkerError || !dsn || !(await telemetryConsent())) return;

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
    await reportWorkerError(operation, error).catch((reportError: unknown) => {
      console.debug('[sable service-worker] error not reported', reportError);
    });
    throw error;
  }
}
