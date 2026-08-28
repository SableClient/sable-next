// @vitest-environment happy-dom

import { mount } from 'svelte';
import { expect, test } from 'vitest';

import LogList from './log-list.svelte';
import { debugLog, setDebugLogging } from './debug-log.svelte.js';

const originalWarn = console.warn;

test('console output during render does not feed back into the log store', async () => {
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
    originalWarn(...args);
  };

  setDebugLogging(true);
  console.info('seed entry');
  await Promise.resolve();
  const consoleCallsBefore = debugLog.entries.length;
  expect(consoleCallsBefore).toBeGreaterThan(0);

  const target = document.createElement('div');
  document.body.appendChild(target);
  const consoleWarnInRender = () => {
    console.warn('[svelte] state_unsafe_mutation');
  };
  mount(LogList, { target, props: { warn: consoleWarnInRender } });

  await new Promise((resolve) => setTimeout(resolve, 50));

  const growth = debugLog.entries.length - consoleCallsBefore;
  expect(growth).toBeLessThanOrEqual(1);
  expect(target.querySelectorAll('details').length).toBeLessThanOrEqual(2);

  setDebugLogging(false);
  console.warn = originalWarn;
});
