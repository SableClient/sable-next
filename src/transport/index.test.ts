import { describe, expect, it, vi } from 'vitest';

import { CoreError, applyDiffs, commandFailed } from './index';

describe('applyDiffs', () => {
  it('applies a mixed pagination batch without changing the current timeline', () => {
    const current = ['newer-a', 'newer-b'];

    const next = applyDiffs(current, [
      { op: 'push_front', value: 'older-b' },
      { op: 'push_front', value: 'older-a' },
      { op: 'append', values: ['newer-c'] },
      { op: 'set', index: 3, value: 'newer-c-updated' },
    ]);

    expect(next).toEqual(['older-a', 'older-b', 'newer-a', 'newer-c-updated', 'newer-c']);
    expect(current).toEqual(['newer-a', 'newer-b']);
  });

  it.each([
    ['append', ['a', 'b'], [{ op: 'append', values: ['c', 'd'] }], ['a', 'b', 'c', 'd']],
    ['clear', ['a', 'b'], [{ op: 'clear' }], []],
    ['push_front', ['b'], [{ op: 'push_front', value: 'a' }], ['a', 'b']],
    ['push_back', ['a'], [{ op: 'push_back', value: 'b' }], ['a', 'b']],
    ['pop_front', ['a', 'b'], [{ op: 'pop_front' }], ['b']],
    ['pop_back', ['a', 'b'], [{ op: 'pop_back' }], ['a']],
    ['insert', ['a', 'c'], [{ op: 'insert', index: 1, value: 'b' }], ['a', 'b', 'c']],
    ['set', ['a', 'b'], [{ op: 'set', index: 1, value: 'c' }], ['a', 'c']],
    ['remove', ['a', 'b', 'c'], [{ op: 'remove', index: 1 }], ['a', 'c']],
    ['truncate', ['a', 'b', 'c'], [{ op: 'truncate', length: 2 }], ['a', 'b']],
    ['reset', ['a', 'b'], [{ op: 'reset', values: ['c', 'd'] }], ['c', 'd']],
  ] as const)('applies %s', (_operation, current, diffs, expected) => {
    const original = [...current];

    expect(applyDiffs(current, diffs)).toEqual(expected);
    expect(current).toEqual(original);
  });
});

describe('CoreError', () => {
  const report = {
    frames: [
      { message: 'user_profile', location: 'src/profiles.rs:40:9', debug: null },
      {
        message: 'error sending request',
        location: 'src/profiles.rs:38:14',
        debug: 'Reqwest(reqwest::Error { kind: Request })',
      },
    ],
    http: { status: 502, errcode: null, message: null, body: null, url: 'https://hs/_matrix' },
    span_trace: '0: sable_core::api::rpc\n   with method=account.user_profile',
  };

  it('names the command, log id and every frame', () => {
    const error = new CoreError({ code: 'failed', log_id: 'e3', report }, 'account.user_profile');

    expect(error.message).toBe(
      'account.user_profile: failed [e3] user_profile: error sending request'
    );
  });

  function captureConsole() {
    const lines: unknown[][] = [];
    const spies = (['log', 'info', 'groupCollapsed', 'groupEnd'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        if (level === 'log' || level === 'info') lines.push(args);
      })
    );
    const captured = (['error', 'warn'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    );
    return {
      lines,
      captured,
      restore() {
        for (const spy of [...spies, ...captured]) spy.mockRestore();
      },
    };
  }

  it('prints the whole report to the console', () => {
    const output = captureConsole();

    commandFailed({ code: 'failed', log_id: 'e3', report }, 'account.user_profile');

    const printed = output.lines.map((args) => args.map(String).join(' ')).join('\n');
    expect(printed).toContain('error sending request at src/profiles.rs:38:14');
    expect(printed).toContain('Reqwest(reqwest::Error');
    expect(printed).toContain('with method=account.user_profile');
    expect(output.lines.some((args) => args[1] === report.http)).toBe(true);
    output.restore();
  });

  it.each([
    [{ code: 'failed', log_id: 'e3', report }],
    [{ code: 'denied', report }],
    [{ code: 'denied' }],
  ] as const)('keeps a failed command off the levels Sentry captures', (detail) => {
    const output = captureConsole();

    commandFailed(detail, 'members.kick');

    for (const spy of output.captured) expect(spy).not.toHaveBeenCalled();
    output.restore();
  });

  it('keeps the fields of a structured code', () => {
    const error = new CoreError({ code: 'rate_limited', retry_after_ms: 2000 }, 'rooms.join');

    expect(error.message).toBe('rooms.join: rate_limited {"retry_after_ms":2000}');
  });

  it('logs a bare code with its fields', () => {
    const output = captureConsole();
    const failure = commandFailed({ code: 'denied' }, 'members.kick');

    expect(output.lines).toEqual([['[sable core] members.kick: denied', { code: 'denied' }]]);
    expect(failure).toBeInstanceOf(CoreError);
    output.restore();
  });

  it('prints the report behind a classified code', () => {
    const output = captureConsole();

    const failure = commandFailed({ code: 'denied', report }, 'members.kick');

    expect(failure.message).toBe('members.kick: denied: user_profile: error sending request');
    expect(output.lines.some((args) => args[1] === report.http)).toBe(true);
    output.restore();
  });
});
