import type { Breadcrumb, Event } from '@sentry/sveltekit';

import { sanitizePayload, scrubMatrixIds, scrubMatrixUrl } from './scrubbers.js';

export function scrubBreadcrumb<T extends Breadcrumb>(breadcrumb: T): T {
  if (breadcrumb.message) breadcrumb.message = scrubMatrixIds(breadcrumb.message);
  if (breadcrumb.data) {
    breadcrumb.data = sanitizePayload(breadcrumb.data) as typeof breadcrumb.data;
  }
  return breadcrumb;
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  if (event.message) event.message = scrubMatrixIds(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubMatrixUrl(scrubMatrixIds(exception.value));
    // A frame raised on a page carries its route, and a room route names the room.
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = scrubMatrixUrl(frame.filename);
      if (frame.abs_path) frame.abs_path = scrubMatrixUrl(frame.abs_path);
    }
  }
  for (const breadcrumb of event.breadcrumbs ?? []) scrubBreadcrumb(breadcrumb);
  if (event.transaction) event.transaction = scrubMatrixUrl(event.transaction);
  if (event.contexts) event.contexts = sanitizePayload(event.contexts) as typeof event.contexts;
  if (event.extra) event.extra = sanitizePayload(event.extra) as typeof event.extra;
  if (event.tags) event.tags = sanitizePayload(event.tags) as typeof event.tags;
  if (event.fingerprint) event.fingerprint = event.fingerprint.map(scrubMatrixIds);
  if (event.request?.url) event.request.url = scrubMatrixIds(scrubMatrixUrl(event.request.url));
  // The Referer names the page the app was opened from, a room route included.
  if (event.request?.headers) {
    event.request.headers = sanitizePayload(event.request.headers) as typeof event.request.headers;
  }
  return event;
}
