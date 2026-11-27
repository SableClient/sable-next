import { assert, describe, expect, it } from 'vitest';

import { t } from '#lib/i18n.js';
import { settingsCategories, settingsTargets, settingFocusId } from '#lib/settings/registry.js';

import { buildSettingsLink, parseSettingsLink } from './settings-link';
import { settingsLinkLabel } from './settings-link-label';

describe('custom panel links', () => {
  it.each([
    ['appearance', 'quick-css', 'settings.quickCss'],
    ['notifications', 'notification-keywords', 'settings.notificationKeywords'],
    ['notifications', 'notification-event-reactions', 'settings.notificationReactions'],
    ['notifications', 'mention-display_name', 'common.displayName'],
    ['notifications', 'notification-badge-badgeDefaultDirect', 'common.directMessages'],
    ['devices', 'key-backup-heading', 'settings.keyBackupTitle'],
    ['personas', 'settings-personas-backup', 'personas.backupTitle'],
    ['notifications', 'sound-volume-camera_on', 'sounds.camera_on'],
  ])('labels %s / %s with its setting name', (section, focus, name) => {
    const category = settingsCategories.find((entry) => entry.id === section);
    assert(category);
    expect(settingsLinkLabel({ section, focus })).toBe(`${t(category.name)} / ${t(name)}`);
  });

  it('keeps the category label when an anchor is unknown', () => {
    expect(settingsLinkLabel({ section: 'appearance', focus: 'unknown' })).toBe(
      t('settings.appearanceTitle')
    );
  });

  it('resolves every custom anchor, including moved links and non-kebab-case IDs', () => {
    const origin = 'https://sable.example';
    for (const category of settingsCategories) {
      for (const target of category.targets ?? []) {
        const focus = target.focusId ?? settingFocusId(target.key);
        const href = buildSettingsLink(origin, 'old-category', focus);
        const parsed = parseSettingsLink(href, origin);
        expect(parsed, focus).toEqual({ section: category.id, focus });
        assert(parsed);
        expect(settingsLinkLabel(parsed), focus).toBe(`${t(category.name)} / ${t(target.name)}`);
      }
    }
  });

  it('assigns each target a unique anchor across all categories', () => {
    const anchors = settingsCategories.flatMap((category) =>
      settingsTargets(category).map((target) => target.focusId ?? settingFocusId(target.key))
    );
    expect(new Set(anchors).size).toBe(anchors.length);
  });
});
