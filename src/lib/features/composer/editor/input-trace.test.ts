// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import { clearDebugLogs, debugLog, setDebugLogging } from '#lib/observability/debug-log.svelte.js';

import { traceComposerInput } from './input-trace';

afterEach(() => {
  setDebugLogging(false);
  clearDebugLogs();
});

test('records the shape of a newline without the text typed', async () => {
  setDebugLogging(true);
  const node = document.createElement('div');
  node.innerHTML = '<p>secret words</p>';
  const stop = traceComposerInput(node);

  node.dispatchEvent(
    new InputEvent('beforeinput', { inputType: 'insertText', data: 'secret\n', cancelable: true })
  );
  await Promise.resolve();
  stop();

  const entry = debugLog.entries.find((item) => item.namespace === 'composer-input');
  expect(entry?.message).toBe('beforeinput');
  expect(entry?.data).toMatchObject({
    inputType: 'insertText',
    newlines: 1,
    length: 7,
    paragraphs: 1,
  });
  expect(JSON.stringify(debugLog.entries)).not.toContain('secret');
});
