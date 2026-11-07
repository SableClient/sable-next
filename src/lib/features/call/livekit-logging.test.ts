import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getLogger, LoggerNames } from 'livekit-client';

const sentry = vi.hoisted(() => ({ addBreadcrumb: vi.fn() }));
vi.mock('@sentry/sveltekit', () => sentry);

const debugLog = vi.hoisted(() => ({ recordDebugLog: vi.fn() }));
vi.mock('#lib/observability/debug-log.svelte.js', () => debugLog);

import { routeLivekitLogs } from './livekit-logging';

const consoleMethods = ['error', 'warn', 'info', 'debug', 'log', 'trace'] as const;
const spies = new Map<string, ReturnType<typeof vi.spyOn>>();

beforeEach(() => {
  for (const method of consoleMethods) spies.set(method, vi.spyOn(console, method));
  sentry.addBreadcrumb.mockClear();
  debugLog.recordDebugLog.mockClear();
  routeLivekitLogs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('never writes livekit logs to the console', () => {
  for (const name of Object.values(LoggerNames)) {
    const logger = getLogger(name);
    logger.error('websocket error during connection');
    logger.warn('signal stream closed');
    logger.info('connected');
  }
  for (const spy of spies.values()) expect(spy).not.toHaveBeenCalled();
});

test('keeps warnings and errors as breadcrumbs and everything in the debug log', () => {
  const logger = getLogger(LoggerNames.Signal);
  logger.error('signal timed out', { attempt: 2 });
  logger.warn('leave request while reconnecting');
  logger.info('connected');

  expect(sentry.addBreadcrumb).toHaveBeenCalledTimes(2);
  expect(sentry.addBreadcrumb).toHaveBeenCalledWith({
    category: 'livekit',
    level: 'error',
    message: 'signal timed out',
    data: { logger: LoggerNames.Signal, attempt: 2 },
  });
  expect(debugLog.recordDebugLog).toHaveBeenCalledWith(
    'error',
    'call',
    LoggerNames.Signal,
    'signal timed out',
    { attempt: 2 }
  );
  expect(debugLog.recordDebugLog).toHaveBeenCalledTimes(3);
});
