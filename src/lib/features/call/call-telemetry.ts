import * as Sentry from '@sentry/sveltekit';

import { TransportDisconnectError } from './call-transport';

type Attribute = string | number | boolean;
type Attributes = Record<string, Attribute>;
type Outcome = 'connected' | 'failed' | 'cancelled';

const safeErrorNames = new Set([
  'AbortError',
  'Error',
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'OperationError',
  'TimeoutError',
  'TypeError',
]);

const expectedDeviceErrors = new Set(['AbortError', 'NotAllowedError', 'NotFoundError']);

const expectedDisconnectReasons = new Set([
  'CLIENT_INITIATED',
  'DUPLICATE_IDENTITY',
  'PARTICIPANT_REMOVED',
  'ROOM_CLOSED',
  'ROOM_DELETED',
]);

export const isExpectedDeviceError = (name: string): boolean => expectedDeviceErrors.has(name);

const safeCodes = new Set([
  'busy',
  'cancelled',
  'connect_failed',
  'disconnected',
  'failed',
  'invalid_request',
  'media_failed',
  'no_call_focus',
  'not_logged_in',
  'own-key-failed',
  'own-key-timeout',
  'permission_denied',
  'transport-not-connected',
  'unavailable',
  'unexpected',
]);

const safeMessages = new Map([
  ['e2ee-unsupported', 'code.e2ee-unsupported'],
  ['key-import-failed', 'code.key-import-failed'],
  ['native-transport-skipped', 'code.native-transport-skipped'],
  ['own-key-failed', 'code.own-key-failed'],
  ['own-key-timeout', 'code.own-key-timeout'],
  ['signaling-error', 'code.signaling-error'],
  ['transport-not-connected', 'code.transport-not-connected'],
]);

const attemptId = (): string => crypto.randomUUID();

const errorCategory = (error: unknown): string => {
  if (error instanceof TransportDisconnectError) return `disconnect.${error.reason}`;
  if (error && typeof error === 'object') {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
    if (code && safeCodes.has(code)) return `code.${code}`;

    const detail = 'detail' in error && typeof error.detail === 'object' && error.detail;
    const detailCode =
      detail && 'code' in detail && typeof detail.code === 'string' ? detail.code : undefined;
    if (detailCode && safeCodes.has(detailCode)) return `code.${detailCode}`;
  }
  if (error instanceof Error) {
    const messageCategory = safeMessages.get(error.message);
    if (messageCategory) return messageCategory;
    if (safeErrorNames.has(error.name)) return `error.${error.name}`;
  }
  return 'error.unknown';
};

const logIdOf = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('detail' in error)) return undefined;
  const detail = error.detail;
  return detail &&
    typeof detail === 'object' &&
    'log_id' in detail &&
    typeof detail.log_id === 'string'
    ? detail.log_id
    : undefined;
};

const isExpected = (error: unknown): boolean => {
  if (error instanceof TransportDisconnectError) return expectedDisconnectReasons.has(error.reason);
  return error instanceof Error && expectedDeviceErrors.has(error.name);
};

export class CallTelemetry {
  readonly attemptId: string;
  readonly #attributes: Attributes;
  readonly #root: Sentry.Span;
  readonly #reportedFailures = new Set<string>();
  readonly #failedStages = new WeakMap<object, string>();
  #joining = true;
  #finished = false;
  #reported = false;
  #failedStage: string | undefined;

  constructor(attributes: Attributes = {}) {
    this.attemptId = attemptId();
    this.#attributes = { ...attributes, 'call.attempt_id': this.attemptId };
    this.#root = Sentry.startInactiveSpan({
      name: 'call.join',
      op: 'call.join',
      parentSpan: null,
      attributes: this.#attributes,
    });
  }

  async step<T>(stage: string, action: () => Promise<T>, attributes: Attributes = {}): Promise<T> {
    const span = Sentry.startInactiveSpan({
      name: stage,
      op: stage,
      parentSpan: this.#joining ? this.#root : null,
      attributes: { ...this.#attributes, ...attributes },
    });
    try {
      const result = await action();
      span.setStatus({ code: 1 });
      return result;
    } catch (error) {
      span.setStatus({ code: 2 });
      this.failure(stage, error, attributes);
      throw error;
    } finally {
      span.end();
    }
  }

  event(stage: string, attributes: Attributes = {}): void {
    Sentry.addBreadcrumb({
      category: 'call',
      level: 'info',
      message: stage,
      data: { ...this.#attributes, ...attributes },
    });
    const span = Sentry.startInactiveSpan({
      name: stage,
      op: stage,
      parentSpan: this.#joining ? this.#root : null,
      attributes: { ...this.#attributes, ...attributes },
    });
    span.setStatus({ code: 1 });
    span.end();
  }

  // A failed step is context for the call's outcome, not an error of its own. It stays on
  // the trace and as a breadcrumb until terminal() decides the call itself failed.
  failure(stage: string, error: unknown, attributes: Attributes = {}): void {
    if (error && typeof error === 'object') {
      if (this.#failedStages.has(error)) return;
      this.#failedStages.set(error, stage);
    }
    this.#failedStage ??= stage;
    const category = errorCategory(error);
    const key = `${stage}:${category}:${attributes['call.backend_id'] ?? ''}:${attributes['call.participant_index'] ?? ''}`;
    if (this.#reportedFailures.has(key)) return;
    this.#reportedFailures.add(key);

    const logId = logIdOf(error);
    const data = {
      ...this.#attributes,
      ...attributes,
      'call.stage': stage,
      'call.error_category': category,
      ...(logId ? { 'call.log_id': logId } : {}),
    };
    Sentry.addBreadcrumb({
      category: 'call',
      level: isExpected(error) ? 'info' : 'error',
      message: `${stage} failed`,
      data,
    });
    const span = Sentry.startInactiveSpan({
      name: 'call.failure',
      op: 'call.failure',
      parentSpan: null,
      attributes: data,
      links: [
        { context: this.#root.spanContext(), attributes: { 'sentry.link.type': 'previous_trace' } },
      ],
    });
    span.setStatus({ code: 2 });
    span.end();
  }

  // The call could not be joined or ended abnormally. Reports one event per call
  // carrying the real cause, unless that cause is an expected outcome.
  terminal(stage: string, error: unknown, attributes: Attributes = {}): void {
    this.failure(stage, error, attributes);
    if (this.#reported || isExpected(error)) return;
    this.#reported = true;

    const failedStage =
      (error !== null && typeof error === 'object' ? this.#failedStages.get(error) : undefined) ??
      stage;
    const category = errorCategory(error);
    const logId = logIdOf(error);
    Sentry.withActiveSpan(this.#root, () => {
      Sentry.captureException(new Error(`Call failed: ${failedStage}`), {
        contexts: {
          call: {
            ...this.#attributes,
            ...attributes,
            'call.stage': failedStage,
            'call.error_category': category,
            ...(logId ? { 'call.log_id': logId } : {}),
          },
        },
        fingerprint: ['call', failedStage, category],
        tags: { 'call.stage': failedStage, 'call.error_category': category },
      });
    });
  }

  // The call stays up but part of it does not work, like a microphone that never
  // publishes. Reported once per stage and cause, as a warning when it was refused.
  degraded(stage: string, error: unknown, attributes: Attributes = {}): void {
    this.failure(stage, error, attributes);
    const category = errorCategory(error);
    const key = `degraded:${stage}:${category}`;
    if (this.#reportedFailures.has(key)) return;
    this.#reportedFailures.add(key);
    Sentry.withActiveSpan(this.#root, () => {
      Sentry.captureException(new Error(`Call degraded: ${stage}`), {
        level: isExpected(error) ? 'warning' : 'error',
        contexts: {
          call: {
            ...this.#attributes,
            ...attributes,
            'call.stage': stage,
            'call.error_category': category,
          },
        },
        fingerprint: ['call', 'degraded', stage, category],
        tags: { 'call.stage': stage, 'call.error_category': category },
      });
    });
  }

  finish(outcome: Outcome): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#joining = false;
    this.#root.setAttributes({
      'call.outcome': outcome,
      ...(this.#failedStage ? { 'call.failed_stage': this.#failedStage } : {}),
    });
    this.#root.setStatus({ code: outcome === 'failed' ? 2 : 1 });
    this.#root.end();
  }
}
