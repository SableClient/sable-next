import { expect, test } from 'vitest';
import { migrateSettings, SETTINGS_SCHEMA } from './migrations.js';

test('runs every step for a payload with no schema', () => {
  expect(migrateSettings({ fontScale: 'large', desktopNotifications: false }, undefined)).toEqual({
    fontScale: 'large',
    desktopNotifications: false,
    pageZoom: 1.125,
    systemNotifications: false,
  });
});

test('skips steps at or below the stored schema', () => {
  const stored = { fontScale: 'large', desktopNotifications: false };

  expect(migrateSettings(stored, SETTINGS_SCHEMA)).toBe(stored);
});

test('treats a malformed schema as none', () => {
  expect(migrateSettings({ fontScale: 'huge' }, 'two')).toMatchObject({ pageZoom: 1.5 });
  expect(migrateSettings({ fontScale: 'huge' }, -3)).toMatchObject({ pageZoom: 1.5 });
});

test('does not mutate its input', () => {
  const stored = { fontScale: 'large' };
  migrateSettings(stored, 0);

  expect(stored).toEqual({ fontScale: 'large' });
});
