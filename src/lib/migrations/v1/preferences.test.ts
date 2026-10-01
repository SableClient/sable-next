// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function loadWith(stored: Record<string, unknown>) {
  localStorage.setItem('sable-preferences', JSON.stringify(stored));
  const { preferences } = await import('#lib/settings/preferences.svelte.js');
  return preferences;
}

test('converts v1 percentages, layouts and renamed settings while keeping the source', async () => {
  const old = {
    pageZoom: 125,
    messageLayout: 2,
    messageSpacing: '100',
    hideNickAvatarEvents: false,
    editorButtonOrder: ['emoji', 'gif', 'sticker'],
    pmpNoFallback: true,
    useSystemTheme: true,
  };
  localStorage.setItem('settings', JSON.stringify(old));
  const { preferences, isExplicitPreference } = await import('#lib/settings/preferences.svelte.js');
  expect(preferences).toMatchObject({
    pageZoom: 1.25,
    layout: 'bubble',
    messageSpacing: 'compact',
    hideProfileChanges: false,
    personaFallback: false,
    theme: 'system',
  });
  expect(preferences.composerButtonOrder.slice(0, 3)).toEqual(['emoticon', 'gif', 'sticker']);
  expect(isExplicitPreference('hideProfileChanges')).toBe(true);
  expect(JSON.parse(localStorage.getItem('settings') ?? '{}')).toEqual(old);
  expect(JSON.parse(localStorage.getItem('sable-preferences') ?? '{}') as unknown).toMatchObject({
    pageZoom: 1.25,
  });
});

test('an existing v2 preference document takes precedence over v1 settings', async () => {
  localStorage.setItem('settings', JSON.stringify({ pageZoom: 150, messageLayout: 2 }));
  expect(await loadWith({ pageZoom: 0.9 })).toMatchObject({ pageZoom: 0.9, layout: 'modern' });
});

test('invalid v1 settings cannot replace valid v2 defaults', async () => {
  localStorage.setItem(
    'settings',
    JSON.stringify({
      pageZoom: '200',
      messageLayout: 99,
      useSystemNotifications: 'true',
      twitterEmoji: 0,
    })
  );
  const { preferences } = await import('#lib/settings/preferences.svelte.js');
  expect(preferences).toMatchObject({ pageZoom: 1, layout: 'modern', twitterEmoji: true });
});
