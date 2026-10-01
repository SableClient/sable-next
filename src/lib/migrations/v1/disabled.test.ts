// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  V1_MIGRATION_ENABLED: false,
}));

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

test('disabled migration ignores v1 credentials, settings and server events', async () => {
  localStorage.setItem('matrixSessions', 'invalid retired credentials');
  localStorage.setItem('settings', JSON.stringify({ pageZoom: 150, messageLayout: 2 }));
  const getItem = vi.spyOn(Storage.prototype, 'getItem');
  const { migrateV1 } = await import('./migration.js');
  expect(migrateV1()).toBeUndefined();
  const { preferences } = await import('#lib/settings/preferences.svelte.js');
  expect(preferences).toMatchObject({ pageZoom: 1, layout: 'modern' });
  const { settingsDocument, workspaceDocument } = await import('#lib/settings/sync-documents.js');
  const { SpaceSidebar } = await import('#lib/spaces/sidebar-layout.svelte.js');
  expect(settingsDocument.legacy).toBeUndefined();
  expect(workspaceDocument(new SpaceSidebar()).legacy).toBeUndefined();
  expect(getItem).not.toHaveBeenCalledWith('matrixSessions');
  expect(getItem).not.toHaveBeenCalledWith('settings');
  expect(localStorage.getItem('sable-preferences')).toBeNull();
});

test('disabled migration loads existing v2 preferences', async () => {
  const current = JSON.stringify({ pageZoom: 1.25, layout: 'bubble' });
  const original = JSON.stringify({ pageZoom: 150, messageLayout: 1 });
  localStorage.setItem('sable-preferences', current);
  localStorage.setItem('settings', original);
  const { preferences } = await import('#lib/settings/preferences.svelte.js');
  expect(preferences).toMatchObject({ pageZoom: 1.25, layout: 'bubble' });
  expect(localStorage.getItem('sable-preferences')).toBe(current);
  expect(localStorage.getItem('settings')).toBe(original);
});
