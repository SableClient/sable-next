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

test('caps console lines per microtask flush', async () => {
  const { debugLog, setDebugLogging } = await import('./debug-log.svelte.js');
  setDebugLogging(true);
  for (let index = 0; index < 20; index += 1) console.error(`flood ${index}`);
  await Promise.resolve();

  expect(debugLog.entries.filter((entry) => entry.namespace === 'console')).toHaveLength(6);
  expect(debugLog.entries.some((entry) => entry.message === '+15 log entries dropped')).toBe(true);
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
