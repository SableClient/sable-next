// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function loadWith(stored: Record<string, unknown> = {}) {
  localStorage.setItem('sable-preferences', JSON.stringify(stored));
  return import('./preferences.svelte.js');
}

test('keeps the custom call service across reloads and can clear it', async () => {
  const settings = await loadWith();
  settings.setPreference('callServiceUrl', 'https://rtc.example.org/');
  vi.resetModules();
  const restored = await import('./preferences.svelte.js');
  expect(restored.preferences.callServiceUrl).toBe('https://rtc.example.org/');
  restored.setPreference('callServiceUrl', '');
  vi.resetModules();
  expect((await import('./preferences.svelte.js')).preferences.callServiceUrl).toBe('');
});

test('switching account defaults restores deployment defaults without storing policy', async () => {
  const settings = await loadWith();
  settings.applyDeploymentDefaults({ theme: 'dark' });
  settings.applyAccountPreferences({ theme: 'light', urlPreviews: true }, {});
  expect(settings.preferences.theme).toBe('light');
  expect(settings.preferences.urlPreviews).toBe(true);
  settings.setPreference('hideTypingIndicators', true);
  const stored: unknown = JSON.parse(localStorage.getItem('sable-preferences') ?? '{}');
  expect(stored).not.toHaveProperty('theme');
  expect(stored).not.toHaveProperty('urlPreviews');

  settings.applyAccountPreferences({}, {});
  expect(settings.preferences.theme).toBe('dark');
  expect(settings.preferences.urlPreviews).toBe(false);
  expect(settings.preferences.hideTypingIndicators).toBe(true);
});

test('account locks restore explicit choices and deployment locks take precedence', async () => {
  const settings = await loadWith({ theme: 'light', sendReadReceipts: true });
  settings.applyAccountPreferences({ theme: 'dark' }, { sendReadReceipts: false });
  expect(settings.preferences.theme).toBe('light');
  expect(settings.preferences.sendReadReceipts).toBe(false);
  expect(settings.isLockedPreference('sendReadReceipts')).toBe(true);
  settings.setPreference('sendReadReceipts', true);
  expect(settings.preferences.sendReadReceipts).toBe(false);
  settings.applyDeploymentLocks({ sendReadReceipts: true });
  expect(settings.preferences.sendReadReceipts).toBe(true);
  settings.applyDeploymentLocks({});
  expect(settings.preferences.sendReadReceipts).toBe(false);
  settings.applyAccountPreferences({}, {});
  expect(settings.preferences.sendReadReceipts).toBe(true);
  expect(settings.isLockedPreference('sendReadReceipts')).toBe(false);
});

test('account policy ignores unsupported and invalid preferences', async () => {
  const settings = await loadWith();
  settings.applyAccountPreferences(
    { quickCss: 'body { display: none }', theme: 'invalid' },
    { pushGatewayUrl: 'https://push.example.org', urlPreviews: 'yes', errorReporting: true }
  );
  expect(settings.preferences.quickCss).toBe('');
  expect(settings.preferences.theme).toBe('system');
  expect(settings.preferences.pushGatewayUrl).toBe('');
  expect(settings.isLockedPreference('pushGatewayUrl')).toBe(false);
  expect(settings.isLockedPreference('urlPreviews')).toBe(false);
  expect(settings.isLockedPreference('errorReporting')).toBe(false);
});

test('account defaults apply hour24Clock', async () => {
  const settings = await loadWith();
  const clock = settings.preferences.hour24Clock;
  settings.applyAccountPreferences({ hour24Clock: !clock }, {});
  expect(settings.preferences.hour24Clock).toBe(!clock);
});

test('account locks and defaults stay out of settings sync and persisted user choices', async () => {
  const settings = await loadWith({ sendReadReceipts: true });
  settings.applyAccountPreferences({ theme: 'dark' }, { sendReadReceipts: false });
  settings.setPreference('urlPreviews', true);
  expect(JSON.parse(localStorage.getItem('sable-preferences') ?? '{}')).toMatchObject({
    sendReadReceipts: true,
    urlPreviews: true,
  });
  const { settingsDocument } = await import('./sync-documents.js');
  const content = settingsDocument.snapshot().content as { settings: Record<string, unknown> };
  expect(content.settings).toEqual({ urlPreviews: true });
});

test('synced choices survive removing account defaults', async () => {
  const settings = await loadWith();
  settings.applyAccountPreferences({ theme: 'dark' }, {});
  settings.applyPreferences({ ...settings.preferences, theme: 'light' }, ['theme']);
  settings.applyAccountPreferences({}, {});
  expect(settings.preferences.theme).toBe('light');
});

test('an account can hide read receipts without persisting that policy to another account', async () => {
  const settings = await loadWith({ hideReadReceipts: false });
  settings.applyAccountPreferences({}, { hideReadReceipts: true });
  expect(settings.preferences.hideReadReceipts).toBe(true);
  expect(settings.isLockedPreference('hideReadReceipts')).toBe(true);
  settings.setPreference('hideReadReceipts', false);
  expect(settings.preferences.hideReadReceipts).toBe(true);
  settings.setPreference('urlPreviews', true);
  expect(JSON.parse(localStorage.getItem('sable-preferences') ?? '{}')).toMatchObject({
    hideReadReceipts: false,
  });
  settings.applyAccountPreferences({}, {});
  expect(settings.preferences.hideReadReceipts).toBe(false);
  expect(settings.isLockedPreference('hideReadReceipts')).toBe(false);
});

test('disabling receipts hides indicators and removes controls until the account changes', async () => {
  const settings = await loadWith({ sendReadReceipts: true, hideReadReceipts: false });
  const { privacyCategory } = await import('./registry/privacy.js');
  const { timelineCategory } = await import('./registry/timeline.js');
  const send = privacyCategory.items.find((item) => item.key === 'sendReadReceipts');
  const hide = timelineCategory.items.find((item) => item.key === 'hideReadReceipts');
  settings.applyAccountPreferences({}, { sendReadReceipts: false });
  expect(settings.preferences.sendReadReceipts).toBe(false);
  expect(settings.preferences.hideReadReceipts).toBe(true);
  expect(send?.supported?.({ oauth: false })).toBe(false);
  expect(hide?.supported?.({ oauth: false })).toBe(false);
  settings.applyAccountPreferences({}, {});
  expect(settings.preferences.sendReadReceipts).toBe(true);
  expect(settings.preferences.hideReadReceipts).toBe(false);
  expect(send?.supported?.({ oauth: false })).toBe(true);
});
