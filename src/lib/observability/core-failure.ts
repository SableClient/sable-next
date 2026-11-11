import * as Sentry from '@sentry/sveltekit';
import type { Event, StackFrame } from '@sentry/sveltekit';
import { isTauri } from '@tauri-apps/api/core';

import type { CoreEvent, ErrorReportView } from '#src/generated/protocol';
import type { CoreError } from '#src/transport';
import { scrubMatrixIds } from './scrubbers.js';

type Failure = Extract<CoreEvent, { type: 'failure' }>;

function reportTags(report: ErrorReportView, origin: string | null): Record<string, string> {
  return {
    ...(origin ? { 'core.origin': origin } : {}),
    ...(report.http?.status ? { 'http.status': String(report.http.status) } : {}),
    ...(report.http?.errcode ? { 'matrix.errcode': report.http.errcode } : {}),
  };
}

/** Sentry flattens anything nested deeper than `normalizeDepth`, so each frame gets its own key. */
function reportContext(report: ErrorReportView): Record<string, unknown> {
  const context: Record<string, unknown> = { http: report.http, span_trace: report.span_trace };
  for (const [index, frame] of report.frames.entries()) context[`frame_${index}`] = frame;
  return context;
}

function originOf(report: ErrorReportView): string | null {
  for (let index = report.frames.length - 1; index >= 0; index -= 1) {
    const location = report.frames[index]?.location;
    if (location) return location;
  }
  return null;
}

function sourceFrame(frame: ErrorReportView['frames'][number]): StackFrame | null {
  const match = /^(.*):(\d+):(\d+)$/.exec(frame.location ?? '');
  if (!match) return null;
  return {
    filename: match[1],
    lineno: Number(match[2]),
    colno: Number(match[3]),
    function: scrubMatrixIds(frame.message),
    in_app: true,
  };
}

const reported = new Set<string>();

/**
 * A core failure, grouped by the line that raised it and sent once per session,
 * so one failing in a retry loop cannot spend the quota. The native shell reports its own.
 */
export function reportCoreFailure({ log_id, context, report }: Failure): void {
  if (isTauri()) return;
  const origin = originOf(report);
  const key = origin ?? context;
  if (reported.has(key)) return;
  reported.add(key);
  Sentry.captureEvent({
    level: 'error',
    exception: {
      values: [
        {
          type: 'CoreFailure',
          value: report.frames.map((frame) => frame.message).join(': '),
          stacktrace: { frames: report.frames.map(sourceFrame).filter((frame) => frame !== null) },
        },
      ],
    },
    fingerprint: ['core', key],
    tags: { source: 'core', context, log_id, ...reportTags(report, origin) },
    contexts: { core: reportContext(report) },
  });
}

/**
 * Tags a rejected command that went uncaught. A `failed` one was already
 * reported by `reportCoreFailure`, so it is dropped here.
 */
export function tagCoreError<T extends Event>(event: T, error: CoreError): T | null {
  const { detail, report } = error;
  if (detail.code === 'failed' && report) return null;
  event.tags = { ...event.tags, 'core.code': detail.code };
  if (error.method) event.tags['rpc.method'] = error.method;
  if (!report) {
    event.fingerprint = ['{{ default }}', detail.code];
    return event;
  }
  const origin = originOf(report);
  event.tags = { ...event.tags, ...reportTags(report, origin) };
  event.contexts = { ...event.contexts, core: reportContext(report) };
  event.fingerprint = ['core', detail.code, error.method ?? '', origin ?? ''];
  return event;
}
