import { beforeEach, expect, test, vi } from 'vitest';

const telemetryMock = vi.hoisted(() => ({
  addBreadcrumb: vi.fn(),
  captureException: vi.fn(),
  spans: [] as { options: Record<string, unknown>; end: ReturnType<typeof vi.fn> }[],
}));

vi.mock('@sentry/sveltekit', () => ({
  addBreadcrumb: telemetryMock.addBreadcrumb,
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
import { TransportDisconnectError } from './call-transport';

beforeEach(() => {
  telemetryMock.spans.length = 0;
  telemetryMock.captureException.mockClear();
  telemetryMock.addBreadcrumb.mockClear();
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
  telemetry.terminal('call.transport.connect', new Error(secret));
  telemetry.finish('failed');

  expect(telemetryMock.captureException).toHaveBeenCalledOnce();
  const [error, context] = telemetryMock.captureException.mock.calls[0] as [
    { message: string },
    { contexts: { call: Record<string, unknown> } },
  ];
  expect(error.message).toBe('Call failed: call.transport.connect');
  expect(context.contexts.call).toMatchObject({
    'call.stage': 'call.transport.connect',
    'call.error_category': 'error.Error',
    'call.attempt_id': telemetry.attemptId,
  });
  expect(JSON.stringify(telemetryMock.captureException.mock.calls)).not.toContain(secret);
  expect(telemetryMock.spans[1].end).toHaveBeenCalledOnce();
});

test('records a safe native command code without its private detail', () => {
  const telemetry = new CallTelemetry();
  const privateDetail = 'https://sfu.example.org/provision?token=super-secret';
  const error = Object.assign(new Error(privateDetail), {
    detail: { code: 'unavailable' },
  });

  telemetry.terminal('call.signaling.join', error);

  const [, context] = telemetryMock.captureException.mock.calls[0] as [
    Error,
    { contexts: { call: Record<string, unknown> } },
  ];
  expect(context.contexts.call).toMatchObject({
    'call.stage': 'call.signaling.join',
    'call.error_category': 'code.unavailable',
  });
  expect(JSON.stringify(telemetryMock.captureException.mock.calls)).not.toContain(privateDetail);
});

test('keeps matching failures from separate backends distinct', () => {
  const telemetry = new CallTelemetry();

  telemetry.failure('call.backend.connect', new Error('failed'), {
    'call.backend_id': 'first',
  });
  telemetry.failure('call.backend.connect', new Error('failed'), {
    'call.backend_id': 'second',
  });

  expect(telemetryMock.addBreadcrumb).toHaveBeenCalledTimes(2);
  for (const [index, backendId] of ['first', 'second'].entries()) {
    expect(telemetryMock.addBreadcrumb).toHaveBeenNthCalledWith(
      index + 1,
      expect.objectContaining({
        data: expect.objectContaining({ 'call.backend_id': backendId }) as unknown,
      })
    );
  }
});

test('records a failed step as a breadcrumb and an error span without an event', async () => {
  const telemetry = new CallTelemetry();

  await expect(
    telemetry.step('call.transport.connect', () => Promise.reject(new Error('boom')))
  ).rejects.toThrow('boom');
  telemetry.failure('call.signaling.leave', new Error('boom'));

  expect(telemetryMock.captureException).not.toHaveBeenCalled();
  expect(telemetryMock.addBreadcrumb).toHaveBeenCalledWith(
    expect.objectContaining({
      category: 'call',
      level: 'error',
      message: 'call.transport.connect failed',
    })
  );
  expect(telemetryMock.spans.filter(({ options }) => options.name === 'call.failure')).toHaveLength(
    2
  );
});

test('reports a terminal failure once with the stage that first failed', async () => {
  const telemetry = new CallTelemetry();
  const cause = new Error('rpc');
  await expect(telemetry.step('call.signaling.join', () => Promise.reject(cause))).rejects.toBe(
    cause
  );

  telemetry.terminal('call.join', cause);
  telemetry.terminal('call.transport.disconnected', new Error('later'));

  expect(telemetryMock.captureException).toHaveBeenCalledOnce();
  const [error, context] = telemetryMock.captureException.mock.calls[0] as [
    Error,
    { fingerprint: string[]; tags: Record<string, string> },
  ];
  expect(error.message).toBe('Call failed: call.signaling.join');
  expect(context.fingerprint).toEqual(['call', 'call.signaling.join', 'error.Error']);
  expect(context.tags['call.stage']).toBe('call.signaling.join');
});

test('reports the core error code and log id of a failed RPC', () => {
  const telemetry = new CallTelemetry();
  const cause = Object.assign(new Error('rpc failed'), {
    detail: { code: 'failed', log_id: 'log-123' },
  });

  telemetry.terminal('call.join', cause);

  const [, context] = telemetryMock.captureException.mock.calls[0] as [
    Error,
    { contexts: { call: Record<string, unknown> }; fingerprint: string[] },
  ];
  expect(context.contexts.call).toMatchObject({
    'call.error_category': 'code.failed',
    'call.log_id': 'log-123',
  });
  expect(context.fingerprint).toEqual(['call', 'call.join', 'code.failed']);
});

test('reports the livekit disconnect reason by name', () => {
  const telemetry = new CallTelemetry();

  telemetry.terminal(
    'call.transport.disconnected',
    new TransportDisconnectError('CONNECTION_TIMEOUT')
  );

  const [, context] = telemetryMock.captureException.mock.calls[0] as [
    Error,
    { tags: Record<string, string> },
  ];
  expect(context.tags['call.error_category']).toBe('disconnect.CONNECTION_TIMEOUT');
});

test.each(['NotAllowedError', 'NotFoundError', 'AbortError'])(
  'does not report %s as a failed call',
  (name) => {
    const telemetry = new CallTelemetry();

    telemetry.terminal('call.join', Object.assign(new Error('device'), { name }));

    expect(telemetryMock.captureException).not.toHaveBeenCalled();
    expect(telemetryMock.addBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'info' })
    );
  }
);

test.each(['CLIENT_INITIATED', 'ROOM_DELETED', 'PARTICIPANT_REMOVED'])(
  'does not report a %s disconnect as a failed call',
  (reason) => {
    const telemetry = new CallTelemetry();

    telemetry.terminal('call.transport.disconnected', new TransportDisconnectError(reason));

    expect(telemetryMock.captureException).not.toHaveBeenCalled();
  }
);

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
  expect(telemetryMock.addBreadcrumb).toHaveBeenCalledWith({
    category: 'call',
    level: 'info',
    message: 'call.transport.state',
    data: {
      'call.attempt_id': telemetry.attemptId,
      'call.connection': 'reconnecting',
    },
  });
});
