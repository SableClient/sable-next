import type { Event } from '@sentry/sveltekit';

import { sanitizePayload, scrubMatrixIds, scrubMatrixUrl } from './scrubbers.js';

export function scrubSentryEvent<T extends Event>(event: T): T {
  if (event.message) event.message = scrubMatrixIds(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubMatrixUrl(scrubMatrixIds(exception.value));
  }
  if (event.transaction) event.transaction = scrubMatrixUrl(event.transaction);
  if (event.contexts) event.contexts = sanitizePayload(event.contexts) as typeof event.contexts;
  if (event.extra) event.extra = sanitizePayload(event.extra) as typeof event.extra;
  if (event.tags) event.tags = sanitizePayload(event.tags) as typeof event.tags;
  if (event.fingerprint) event.fingerprint = event.fingerprint.map(scrubMatrixIds);
  if (event.request?.url) event.request.url = scrubMatrixIds(scrubMatrixUrl(event.request.url));
  return event;
}
