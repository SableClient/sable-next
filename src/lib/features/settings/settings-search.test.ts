import { describe, expect, it } from 'vitest';
import type { SettingsCategory, SettingsContext } from '#lib/settings/registry.js';
import { searchSettings } from './settings-search.js';

const context: SettingsContext = { oauth: false };

const translations: Record<string, string> = {
  'category.notifications': 'Notifications',
  'setting.systemNotifications': 'System notifications',
  'setting.systemNotificationsHint': 'Hands alerts to your operating system.',
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
    sections: [{ id: 'main', name: 'section.main' }],
    items: [
      {
        key: 'systemNotifications',
        section: 'main',
        icon: (() => {}) as unknown as SettingsCategory['icon'],
        name: 'setting.systemNotifications',
        description: 'setting.systemNotificationsHint',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'media',
    name: 'category.media',
    icon: (() => {}) as unknown as SettingsCategory['icon'],
    sections: [{ id: 'main', name: 'section.main' }],
    items: [
      {
        key: 'autoplayGifs',
        section: 'main',
        icon: (() => {}) as unknown as SettingsCategory['icon'],
        name: 'setting.autoplayGifs',
        description: 'setting.autoplayGifsHint',
        type: 'boolean',
      },
      {
        key: 'urlPreviews',
        section: 'main',
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
    expect(searchSettings('  ', categories, translate, context)).toEqual([]);
  });

  it('matches on the translated setting name', () => {
    const hits = searchSettings('autoplay', categories, translate, context);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.setting.key).toBe('autoplayGifs');
    expect(hits[0]?.category.id).toBe('media');
  });

  it('matches on the translated description, case-insensitively', () => {
    const hits = searchSettings('OPERATING SYSTEM', categories, translate, context);
    expect(hits.map((hit) => hit.setting.key)).toEqual(['systemNotifications']);
  });

  it('matches a setting whose own name does not mention the category', () => {
    const hits = searchSettings('notification', categories, translate, context);
    expect(hits.map((hit) => hit.setting.key)).toEqual(['systemNotifications']);
  });

  it('excludes settings the platform does not support', () => {
    const hits = searchSettings('hidden', categories, translate, context);
    expect(hits).toEqual([]);
  });
});

const enterCopy: Record<string, string> = {
  'settings.enterForNewline': 'Enter starts a new line',
  'settings.enterForNewlineAdaptive': 'Newline on touch screens, send otherwise',
  'settings.enterForNewlineNewline': 'Always inserts a newline',
  'settings.enterForNewlineSend': 'Always sends',
  'settings.enterKey': 'Enter key',
  'settings.enterSends': 'Enter sends',
};

function translateEnter(key: string): string {
  return enterCopy[key] ?? key;
}

describe('enter setting search', () => {
  it('shows the selected mode and matches the switcher choices without a description', async () => {
    const { settingsCategories } = await import('#lib/settings/registry.js');
    const { preferences } = await import('#lib/settings/preferences.svelte.js');
    const previousNewline = preferences.enterForNewline;

    function hit() {
      return searchSettings('Enter sends', settingsCategories, translateEnter, context).find(
        (entry) => entry.setting.key === 'enterForNewline'
      )?.setting;
    }

    try {
      preferences.enterForNewline = 'send';
      expect(hit()?.name).toBe('settings.enterSends');
      expect(hit()?.description).toBeUndefined();
      expect(
        searchSettings('starts a new line', settingsCategories, translateEnter, context).some(
          (entry) => entry.setting.key === 'enterForNewline'
        )
      ).toBe(true);
      preferences.enterForNewline = 'newline';
      expect(hit()?.name).toBe('settings.enterForNewline');
      expect(hit()?.description).toBeUndefined();
      expect(hit()).toBeDefined();

      preferences.enterForNewline = 'adaptive';
      expect(hit()?.name).toBe('settings.enterForNewlineAdaptive');
      expect(hit()?.description).toBeUndefined();
      expect(
        searchSettings('Enter sends', settingsCategories, translateEnter, context).some(
          (entry) => entry.setting.key === 'enterForNewline'
        )
      ).toBe(true);
    } finally {
      preferences.enterForNewline = previousNewline;
    }
  }, 10_000);
});

describe('alt text setting search', () => {
  it('is found by the term "alt text"', async () => {
    const { settingsCategories } = await import('#lib/settings/registry.js');
    const copy: Record<string, string> = {
      'settings.alwaysShowAltText': 'Always show image descriptions',
      'settings.terms.altText': 'Alt text',
    };
    const hits = searchSettings('alt text', settingsCategories, (key) => copy[key] ?? key, context);
    expect(hits.some((entry) => entry.setting.key === 'alwaysShowAltText')).toBe(true);
  }, 10_000);
});

describe('select option search', () => {
  it('finds a select setting by an option label', async () => {
    const { settingsCategories } = await import('#lib/settings/registry.js');
    const { t } = await import('#lib/i18n.js');
    const hits = searchSettings('Roomy', settingsCategories, t, context);
    expect(hits.some((entry) => entry.setting.key === 'messageSpacing')).toBe(true);
  }, 10_000);
});

describe('custom panel search', () => {
  it.each([
    ['quick CSS', 'appearance', 'quick-css'],
    ['keywords', 'notifications', 'notification-keywords'],
    ['reactions', 'notifications', 'notification-event-reactions'],
    ['mute all', 'notifications', 'notification-master-mute'],
    ['encryption', 'devices', 'encryption-heading'],
    ['reset identity', 'devices', 'encryption-heading'],
    ['backup', 'devices', 'key-backup-heading'],
    ['import', 'devices', 'room-keys-import'],
    ['PluralKit', 'personas', 'settings-personas-pluralkit'],
    ['restore', 'personas', 'settings-personas-backup'],
    ['font', 'appearance', 'font-family'],
  ])('finds %s in %s', async (query, categoryId, focusId) => {
    const { settingsCategories } = await import('#lib/settings/registry.js');
    const { t } = await import('#lib/i18n.js');
    const hits = searchSettings(query, settingsCategories, t, context);
    expect(
      hits.some((hit) => hit.category.id === categoryId && hit.setting.focusId === focusId)
    ).toBe(true);
  });

  it('finds a panel by its translated description', async () => {
    const { settingsCategories } = await import('#lib/settings/registry.js');
    const hits = searchSettings(
      'custom appearance rules',
      settingsCategories,
      (key) => (key === 'settings.quickCssHint' ? 'Custom appearance rules' : key),
      context
    );
    expect(hits.map((hit) => hit.setting.focusId)).toEqual(['quick-css']);
  });

  it('hides conditional panels until they are enabled', async () => {
    const { settingsCategories } = await import('#lib/settings/registry.js');
    const { preferences } = await import('#lib/settings/preferences.svelte.js');
    const { t } = await import('#lib/i18n.js');
    const previous = preferences.developerTools;
    try {
      preferences.developerTools = false;
      expect(searchSettings('access token', settingsCategories, t, context)).toEqual([]);
      preferences.developerTools = true;
      expect(
        searchSettings('access token', settingsCategories, t, context).some(
          (hit) => hit.setting.focusId === 'access-token'
        )
      ).toBe(true);
    } finally {
      preferences.developerTools = previous;
    }
  });

  it('hides device linking unless the server uses OAuth', async () => {
    const { settingsCategories } = await import('#lib/settings/registry.js');
    const translateLink = (key: string) => (key === 'qrLogin.titleGrant' ? 'Link a device' : key);
    const linked = (oauth: boolean) =>
      searchSettings('link a device', settingsCategories, translateLink, { oauth }).some(
        (hit) => hit.setting.focusId === 'link-device'
      );
    expect(linked(false)).toBe(false);
    expect(linked(true)).toBe(true);
  });
});
