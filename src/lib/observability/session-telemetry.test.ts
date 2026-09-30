import { afterEach, expect, test, vi } from 'vitest';
import { CoreError } from '#src/transport';

const sentry = vi.hoisted(() => ({ isInitialized: vi.fn(() => true), captureMessage: vi.fn() }));
vi.mock('@sentry/sveltekit', () => sentry);
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
import { reportSessionFailure } from './session-telemetry.js';

afterEach(() => {
  vi.clearAllMocks();
  sentry.isInitialized.mockReturnValue(true);
});

test('reports a restore failure with its native log reference', () => {
  reportSessionFailure('restore', new CoreError({ code: 'failed', log_id: 'e7' }));
  expect(sentry.captureMessage).toHaveBeenCalledWith(
    'session.restore',
    expect.objectContaining({
      tags: { 'session.operation': 'restore', 'session.reason': 'failed', runtime: 'native' },
      extra: { log_id: 'e7' },
    })
  );
});

test('does not include transport error text or arbitrary session-end reasons', () => {
  reportSessionFailure('restore', new Error('secret-token'));
  reportSessionFailure('session_ended', undefined, 'secret-token');
  expect(JSON.stringify(sentry.captureMessage.mock.calls)).not.toContain('secret-token');
});

test('does not capture when reporting is disabled', () => {
  sentry.isInitialized.mockReturnValue(false);
  reportSessionFailure('restore', new Error('failure'));
  expect(sentry.captureMessage).not.toHaveBeenCalled();
});
