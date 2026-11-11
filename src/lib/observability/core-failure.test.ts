import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Event } from '@sentry/sveltekit';

import type { ErrorReportView } from '#src/generated/protocol';
import { CoreError } from '#src/transport';

const sentry = vi.hoisted(() => ({ captureEvent: vi.fn<(event: Event) => string>() }));
const shell = vi.hoisted(() => ({ native: false }));
vi.mock('@sentry/sveltekit', () => sentry);
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => shell.native }));

const report: ErrorReportView = {
  frames: [
    { message: 'join_room', location: 'src/rooms.rs:603:30', debug: null },
    { message: 'refused', location: 'src/rooms.rs:598:14', debug: 'Api(Forbidden)' },
  ],
  http: { status: 403, errcode: 'M_FORBIDDEN', message: 'refused', body: null, url: null },
  span_trace: null,
};

const context = {
  frame_0: report.frames[0],
  frame_1: report.frames[1],
  http: report.http,
  span_trace: null,
};

let reportCoreFailure: typeof import('./core-failure.js').reportCoreFailure;
let tagCoreError: typeof import('./core-failure.js').tagCoreError;

beforeEach(async () => {
  vi.resetModules();
  ({ reportCoreFailure, tagCoreError } = await import('./core-failure.js'));
});

afterEach(() => {
  vi.clearAllMocks();
  shell.native = false;
});

test('a failure repeating from one line is sent once a session', () => {
  for (const log_id of ['e4', 'e5', 'e6']) {
    reportCoreFailure({ type: 'failure', log_id, context: 'join_room', report });
  }

  expect(sentry.captureEvent).toHaveBeenCalledTimes(1);
});

test('a core failure is grouped by the line that raised it', () => {
  reportCoreFailure({ type: 'failure', log_id: 'e4', context: 'join_room', report });

  expect(sentry.captureEvent).toHaveBeenCalledWith({
    level: 'error',
    exception: {
      values: [
        {
          type: 'CoreFailure',
          value: 'join_room: refused',
          stacktrace: {
            frames: [
              {
                filename: 'src/rooms.rs',
                lineno: 603,
                colno: 30,
                function: 'join_room',
                in_app: true,
              },
              {
                filename: 'src/rooms.rs',
                lineno: 598,
                colno: 14,
                function: 'refused',
                in_app: true,
              },
            ],
          },
        },
      ],
    },
    fingerprint: ['core', 'src/rooms.rs:598:14'],
    tags: {
      source: 'core',
      context: 'join_room',
      log_id: 'e4',
      'core.origin': 'src/rooms.rs:598:14',
      'http.status': '403',
      'matrix.errcode': 'M_FORBIDDEN',
    },
    contexts: { core: context },
  });
});

test('a frame names no Matrix id', () => {
  const leaky = {
    ...report,
    frames: [{ message: 'refused by !room:example.org', location: 'a.rs:1:2', debug: null }],
  };
  reportCoreFailure({ type: 'failure', log_id: 'e4', context: 'join_room', report: leaky });

  const frames = sentry.captureEvent.mock.calls[0]?.[0].exception?.values?.[0]?.stacktrace?.frames;
  expect(frames).toEqual([
    { filename: 'a.rs', lineno: 1, colno: 2, function: 'refused by ![ROOM_ID]', in_app: true },
  ]);
});

test('the native shell reports its own failures', () => {
  shell.native = true;
  reportCoreFailure({ type: 'failure', log_id: 'e4', context: 'join_room', report });

  expect(sentry.captureEvent).not.toHaveBeenCalled();
});

test('an uncaught failed command is not reported a second time', () => {
  const error = new CoreError({ code: 'failed', log_id: 'e4', report }, 'rooms.join');

  expect(tagCoreError({}, error)).toBeNull();
});

test('an uncaught classified code keeps its report and groups by origin', () => {
  const error = new CoreError({ code: 'denied', report }, 'rooms.join');

  expect(tagCoreError({}, error)).toEqual({
    tags: {
      'core.code': 'denied',
      'rpc.method': 'rooms.join',
      'core.origin': 'src/rooms.rs:598:14',
      'http.status': '403',
      'matrix.errcode': 'M_FORBIDDEN',
    },
    contexts: { core: context },
    fingerprint: ['core', 'denied', 'rooms.join', 'src/rooms.rs:598:14'],
  });
});

test('a bare code groups on the code alone', () => {
  const error = new CoreError({ code: 'not_logged_in' });

  expect(tagCoreError({}, error)).toEqual({
    tags: { 'core.code': 'not_logged_in' },
    fingerprint: ['{{ default }}', 'not_logged_in'],
  });
});

test('the context stays within the depth Sentry keeps', () => {
  reportCoreFailure({ type: 'failure', log_id: 'e4', context: 'join_room', report });

  const core = sentry.captureEvent.mock.calls[0]?.[0].contexts?.core ?? {};
  for (const value of Object.values(core)) {
    const fields = value !== null && typeof value === 'object' ? Object.values(value) : [];
    expect(fields.every((field) => field === null || typeof field !== 'object')).toBe(true);
  }
});
