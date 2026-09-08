import * as Sentry from '@sentry/sveltekit';

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

const safeCodes = new Set([
  'no_call_focus',
  'own-key-failed',
  'own-key-timeout',
  'transport-not-connected',
]);

const safeMessages = new Map([
  ['own-key-failed', 'code.own-key-failed'],
  ['own-key-timeout', 'code.own-key-timeout'],
  ['transport-not-connected', 'code.transport-not-connected'],
]);

const attemptId = (): string => crypto.randomUUID();

const errorCategory = (error: unknown): string => {
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

export class CallTelemetry {
  readonly attemptId: string;
  readonly #attributes: Attributes;
  readonly #root: Sentry.Span;
  readonly #reportedFailures = new Set<string>();
  readonly #reportedErrors = new WeakSet<object>();
  #joining = true;
  #finished = false;
  #failedStage: string | undefined;

  constructor(attributes: Attributes = {}) {
    this.attemptId = attemptId();
    this.#attributes = { ...attributes, 'call.attempt_id': this.attemptId };
    this.#root = Sentry.startInactiveSpan({
      name: 'call.join',
      op: 'call.join',
      parentSpan: null,
      forceTransaction: true,
      attributes: this.#attributes,
    });
  }

  async step<T>(stage: string, action: () => Promise<T>): Promise<T> {
    const span = Sentry.startInactiveSpan({
      name: stage,
      op: stage,
      parentSpan: this.#joining ? this.#root : null,
      attributes: this.#attributes,
    });
    try {
      const result = await action();
      span.setStatus({ code: 1 });
      return result;
    } catch (error) {
      span.setStatus({ code: 2 });
      this.failure(stage, error);
      throw error;
    } finally {
      span.end();
    }
  }

  event(stage: string, attributes: Attributes = {}): void {
    const span = Sentry.startInactiveSpan({
      name: stage,
      op: stage,
      parentSpan: this.#joining ? this.#root : null,
      attributes: { ...this.#attributes, ...attributes },
    });
    span.setStatus({ code: 1 });
    span.end();
  }

  failure(stage: string, error: unknown): void {
    if (error && typeof error === 'object') {
      if (this.#reportedErrors.has(error)) return;
      this.#reportedErrors.add(error);
    }
    this.#failedStage ??= stage;
    const category = errorCategory(error);
    const key = `${stage}:${category}`;
    if (this.#reportedFailures.has(key)) return;
    this.#reportedFailures.add(key);

    const span = Sentry.startInactiveSpan({
      name: 'call.failure',
      op: 'call.failure',
      parentSpan: null,
      attributes: {
        ...this.#attributes,
        'call.stage': stage,
        'call.error_category': category,
      },
      links: [
        { context: this.#root.spanContext(), attributes: { 'sentry.link.type': 'previous_trace' } },
      ],
    });
    span.setStatus({ code: 2 });
    Sentry.withActiveSpan(span, () => {
      Sentry.captureException(new Error('Call operation failed'), {
        contexts: {
          call: { ...this.#attributes, 'call.stage': stage, 'call.error_category': category },
        },
        fingerprint: ['call', stage, category],
        tags: { 'call.stage': stage, 'call.error_category': category },
      });
    });
    span.end();
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
