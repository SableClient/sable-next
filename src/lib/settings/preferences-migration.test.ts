// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function loadWith(stored: Record<string, unknown>) {
  localStorage.setItem('sable-preferences', JSON.stringify(stored));
  const { preferences } = await import('./preferences.svelte.js');
  return preferences;
}

test('carries the old text size preset over as the page size', async () => {
  const preferences = await loadWith({ fontScale: 'large' });

  expect(preferences.pageZoom).toBe(1.125);
  expect(preferences.textScale).toBe(1);
});

test('prefers a stored page size over the old preset', async () => {
  const preferences = await loadWith({ fontScale: 'huge', pageZoom: 0.9 });

  expect(preferences.pageZoom).toBe(0.9);
});

test('clamps a page size outside its range', async () => {
  const preferences = await loadWith({ pageZoom: 4, textScale: 0.1 });

  expect(preferences.pageZoom).toBe(1.5);
  expect(preferences.textScale).toBe(0.75);
});
