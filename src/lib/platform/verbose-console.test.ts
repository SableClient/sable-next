import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, test, vi } from 'vitest';

const script = readFileSync(
  new URL('../../../src-tauri/src/verbose-console.js', import.meta.url),
  'utf8'
);

function setup({ iframe = false, bridge = true } = {}) {
  const original = vi.fn<(...args: unknown[]) => void>();
  const console = {
    log: original,
    info: original,
    warn: original,
    error: original,
    debug: original,
    trace: original,
  };
  const invoke = vi.fn().mockResolvedValue(undefined);
  const window = { top: {}, __TAURI_INTERNALS__: bridge ? { invoke } : undefined };
  if (!iframe) window.top = window;
  const context = { window, console, Error };
  runInNewContext(script, context);
  return { ...context, original, invoke };
}

test.each(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const)(
  'forwards console.%s and calls the original',
  (level) => {
    const { console, original, invoke } = setup();
    const object = { answer: 42 };
    console[level]('hello', object, null, undefined, 123n);
    expect(original).toHaveBeenCalledWith('hello', object, null, undefined, 123n);
    expect(original.mock.contexts).toEqual([console]);
    expect(invoke).toHaveBeenCalledWith('log_console', {
      level,
      message: 'hello {"answer":42} null undefined "123"',
    });
  }
);

test('formats errors, circular objects, and unprintable values', () => {
  const { console, original, invoke } = setup();
  const error = new Error('failed');
  const circular = { self: {} };
  circular.self = circular;
  const unprintable = {
    toJSON() {
      throw new Error('no JSON');
    },
    toString() {
      throw new Error('no string');
    },
  };
  console.error(error, circular, unprintable);
  expect(original).toHaveBeenCalledWith(error, circular, unprintable);
  expect(invoke).toHaveBeenCalledWith('log_console', {
    level: 'error',
    message: `${error.stack} [object Object] [unprintable]`,
  });
});

test('ignores IPC failures', async () => {
  const { console, original, invoke } = setup();
  invoke.mockRejectedValueOnce(new Error('IPC unavailable'));
  console.warn('one');
  await Promise.resolve();
  invoke.mockImplementationOnce(() => {
    throw new Error('IPC closed');
  });
  expect(() => {
    console.warn('two');
  }).not.toThrow();
  expect(original).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenCalledTimes(2);
});

test.each([{ iframe: true }, { bridge: false }])(
  'skips subframes and missing IPC: %j',
  (options) => {
    const { console, original, invoke } = setup(options);
    expect(console.log).toBe(original);
    console.log('hello');
    expect(invoke).not.toHaveBeenCalled();
  }
);
