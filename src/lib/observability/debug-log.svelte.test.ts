import { afterEach, expect, test, vi } from 'vitest';

const originalConsole = console;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  globalThis.console = originalConsole;
});

test('does not recursively capture console output', async () => {
  let reentered = false;
  const info = vi.fn(() => {
    if (!reentered) {
      reentered = true;
      console.info('nested log');
    }
  });
  vi.stubGlobal('console', { ...originalConsole, info });

  const { debugLog, setDebugLogging } = await import('./debug-log.svelte.js');
  setDebugLogging(true);
  console.info('outer log');
  await Promise.resolve();

  expect(info).toHaveBeenCalledTimes(2);
  expect(debugLog.entries).toHaveLength(1);
  expect(debugLog.entries[0]?.message).toBe('outer log');
});

test('keeps every line of a burst and never grows past the cap', async () => {
  const { debugLog, setDebugLogging } = await import('./debug-log.svelte.js');
  setDebugLogging(true);
  for (let index = 0; index < 5000; index += 1) console.error(`flood ${index}`);

  expect(debugLog.entries.length).toBeGreaterThanOrEqual(1000);
  expect(debugLog.entries.length).toBeLessThanOrEqual(1200);
  expect(debugLog.entries.at(-1)?.message).toBe('flood 4999');
});

test('dedupes consecutive identical console lines', async () => {
  const { debugLog, setDebugLogging } = await import('./debug-log.svelte.js');
  setDebugLogging(true);
  console.error('spinning');
  console.error('spinning');
  console.error('spinning');
  await Promise.resolve();

  expect(debugLog.entries.filter((entry) => entry.message === 'spinning')).toHaveLength(1);
});

test('clearing lets an identical line be recorded again', async () => {
  const { clearDebugLogs, debugLog, setDebugLogging } = await import('./debug-log.svelte.js');
  setDebugLogging(true);
  console.error('same line');
  clearDebugLogs();
  console.error('same line');

  expect(debugLog.entries.filter((entry) => entry.message === 'same line')).toHaveLength(1);
});
