import { describe, expect, it } from 'vitest';

import { buildDiagnosticsBundle } from './diagnostics-bundle.js';
import type { DebugLogEntry } from './debug-log.svelte.js';

const systemInfo = {
  appVersion: '1.2.3',
  platform: 'android',
  osVersion: '14',
  userAgent: 'sable-next test agent',
};

describe('buildDiagnosticsBundle', () => {
  it('redacts a homeserver URL and a Matrix user id carried in a log message', () => {
    const entries: DebugLogEntry[] = [
      {
        id: 1,
        timestamp: 0,
        level: 'error',
        category: 'network',
        namespace: 'sync',
        message: 'sync failed for @alice:example.org against https://matrix.example.org/_matrix',
      },
    ];

    const bundle = JSON.parse(buildDiagnosticsBundle(entries, systemInfo)) as {
      logs: DebugLogEntry[];
    };

    expect(bundle.logs[0]?.message).not.toContain('@alice:example.org');
    expect(bundle.logs[0]?.message).not.toContain('matrix.example.org');
    expect(bundle.logs[0]?.message).toContain('[USER_ID]');
    expect(bundle.logs[0]?.message).toContain('[HOMESERVER]');
  });

  it('redacts an access token carried in a log message', () => {
    const entries: DebugLogEntry[] = [
      {
        id: 1,
        timestamp: 0,
        level: 'debug',
        category: 'network',
        namespace: 'auth',
        message: 'access_token=syt_secret_value_do_not_leak',
      },
    ];

    const bundle = JSON.parse(buildDiagnosticsBundle(entries, systemInfo)) as {
      logs: DebugLogEntry[];
    };

    expect(bundle.logs[0]?.message).not.toContain('syt_secret_value_do_not_leak');
    expect(bundle.logs[0]?.message).toContain('[REDACTED]');
  });

  it('carries the system info and a count alongside the logs', () => {
    const bundle = JSON.parse(buildDiagnosticsBundle([], systemInfo)) as {
      systemInfo: typeof systemInfo;
      logsCount: number;
    };

    expect(bundle.systemInfo).toEqual(systemInfo);
    expect(bundle.logsCount).toBe(0);
  });
});
