import { describe, expect, it } from 'vitest';
import type { SettingsCategory } from '#lib/settings/registry.js';
import { searchSettings } from './settings-search.js';

const translations: Record<string, string> = {
  'category.notifications': 'Notifications',
  'setting.desktopNotifications': 'System notifications',
  'setting.desktopNotificationsHint': 'Hands alerts to your operating system.',
  'category.media': 'Media',
  'setting.autoplayGifs': 'Autoplay GIFs',
  'setting.autoplayGifsHint': 'Off shows a preview with a play button.',
  'setting.hidden': 'Hidden feature',
};

function translate(key: string): string {
  return translations[key] ?? key;
}

const categories: SettingsCategory[] = [
  {
    id: 'notifications',
    name: 'category.notifications',
    icon: (() => {}) as unknown as SettingsCategory['icon'],
    items: [
      {
        key: 'desktopNotifications',
        icon: (() => {}) as unknown as SettingsCategory['icon'],
        name: 'setting.desktopNotifications',
        description: 'setting.desktopNotificationsHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'media',
    name: 'category.media',
    icon: (() => {}) as unknown as SettingsCategory['icon'],
    items: [
      {
        key: 'autoplayGifs',
        icon: (() => {}) as unknown as SettingsCategory['icon'],
        name: 'setting.autoplayGifs',
        description: 'setting.autoplayGifsHint',
        type: 'boolean',
      },
      {
        key: 'urlPreviews',
        icon: (() => {}) as unknown as SettingsCategory['icon'],
        name: 'setting.hidden',
        type: 'boolean',
        supported: () => false,
      },
    ],
  },
];

describe('searchSettings', () => {
  it('returns nothing for a blank query', () => {
    expect(searchSettings('  ', categories, translate)).toEqual([]);
  });

  it('matches on the translated setting name', () => {
    const hits = searchSettings('autoplay', categories, translate);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.setting.key).toBe('autoplayGifs');
    expect(hits[0]?.category.id).toBe('media');
  });

  it('matches on the translated description, case-insensitively', () => {
    const hits = searchSettings('OPERATING SYSTEM', categories, translate);
    expect(hits.map((hit) => hit.setting.key)).toEqual(['desktopNotifications']);
  });

  it('matches a setting whose own name does not mention the category', () => {
    const hits = searchSettings('notification', categories, translate);
    expect(hits.map((hit) => hit.setting.key)).toEqual(['desktopNotifications']);
  });

  it('excludes settings the platform does not support', () => {
    const hits = searchSettings('hidden', categories, translate);
    expect(hits).toEqual([]);
  });
});
