// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

async function load(): Promise<typeof import('./participant-volumes.svelte')> {
  vi.resetModules();
  return import('./participant-volumes.svelte');
}

afterEach(() => {
  localStorage.clear();
});

test('plays calls at full volume until the reader picks another level', async () => {
  const volumes = await load();

  expect(volumes.outputVolume()).toBe(1);
  expect(volumes.effectiveVolume('@amy:example.org')).toBe(1);
});

test('keeps the level the reader picked, including silence', async () => {
  localStorage.setItem('sable-call-output-volume', '0');
  const volumes = await load();

  expect(volumes.outputVolume()).toBe(0);
});
