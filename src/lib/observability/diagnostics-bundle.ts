import type { DiagnosticsSystemInfo } from '#lib/platform/diagnostics.js';

import type { DebugLogEntry } from './debug-log.svelte.js';
import { scrubMatrixIds } from './scrubbers.js';

export function buildDiagnosticsBundle(
  entries: readonly DebugLogEntry[],
  systemInfo: DiagnosticsSystemInfo
): string {
  const iso = (value: number): string => new Date(value).toISOString();
  const redactedInfo: DiagnosticsSystemInfo = {
    appVersion: scrubMatrixIds(systemInfo.appVersion),
    platform: scrubMatrixIds(systemInfo.platform),
    osVersion: scrubMatrixIds(systemInfo.osVersion),
    userAgent: scrubMatrixIds(systemInfo.userAgent),
  };

  return JSON.stringify(
    {
      exportedAt: iso(Date.now()),
      systemInfo: redactedInfo,
      logsCount: entries.length,
      logs: entries.map((entry) => ({
        ...entry,
        timestamp: iso(entry.timestamp),
        message: scrubMatrixIds(entry.message),
      })),
    },
    null,
    2
  );
}
