import { beforeEach, expect, test, vi } from 'vitest';

const telemetryMock = vi.hoisted(() => ({
  captureException: vi.fn(),
  spans: [] as { options: Record<string, unknown>; end: ReturnType<typeof vi.fn> }[],
}));

vi.mock('@sentry/sveltekit', () => ({
  captureException: telemetryMock.captureException,
  startInactiveSpan: vi.fn((options: Record<string, unknown>) => {
    const span = {
      options,
      end: vi.fn(),
      spanContext: vi.fn(() => ({ spanId: 'root-span', traceId: 'root-trace' })),
      setAttributes: vi.fn(),
      setStatus: vi.fn(),
    };
    telemetryMock.spans.push({ options, end: span.end });
    return span;
  }),
  withActiveSpan: vi.fn((_span: unknown, callback: () => void) => {
    callback();
  }),
}));

import { CallTelemetry } from './call-telemetry';

beforeEach(() => {
  telemetryMock.spans.length = 0;
  telemetryMock.captureException.mockClear();
});

test('closes the root and stage spans after a successful join', async () => {
  const telemetry = new CallTelemetry({ 'call.camera_requested': false });

  await telemetry.step('call.signaling.join', () => Promise.resolve());
  telemetry.finish('connected');

  expect(telemetryMock.spans).toHaveLength(2);
  expect(telemetryMock.spans[0].options).toMatchObject({
    name: 'call.join',
    op: 'call.join',
    parentSpan: null,
    forceTransaction: true,
  });
  expect(telemetryMock.spans[1].options.parentSpan).toBeDefined();
  expect(telemetryMock.spans.every((span) => span.end.mock.calls.length === 1)).toBe(true);
});

test('records a bounded sanitized failure with the attempt correlation', async () => {
  const telemetry = new CallTelemetry();
  const secret = 'wss://sfu.example.org?token=super-secret';

  await expect(
    telemetry.step('call.transport.connect', () => Promise.reject(new Error(secret)))
  ).rejects.toThrow(secret);
  telemetry.failure('call.transport.connect', new Error(secret));
  telemetry.finish('failed');

  expect(telemetryMock.captureException).toHaveBeenCalledOnce();
  const [error, context] = telemetryMock.captureException.mock.calls[0] as [
    { message: string },
    { contexts: { call: Record<string, unknown> } },
  ];
  expect(error.message).toBe('Call operation failed');
  expect(context.contexts.call).toMatchObject({
    'call.stage': 'call.transport.connect',
    'call.error_category': 'error.Error',
    'call.attempt_id': telemetry.attemptId,
  });
  expect(JSON.stringify(telemetryMock.captureException.mock.calls)).not.toContain(secret);
  expect(telemetryMock.spans[1].end).toHaveBeenCalledOnce();
});

test('creates runtime events outside the completed join root', () => {
  const telemetry = new CallTelemetry();
  telemetry.finish('connected');
  telemetry.event('call.transport.state', { 'call.connection': 'reconnecting' });

  expect(telemetryMock.spans[1].options).toMatchObject({
    parentSpan: null,
    attributes: {
      'call.attempt_id': telemetry.attemptId,
      'call.connection': 'reconnecting',
    },
  });
  expect(telemetryMock.spans[1].end).toHaveBeenCalledOnce();
});
