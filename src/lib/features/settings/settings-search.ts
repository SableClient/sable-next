import type { SettingDefinition, SettingsCategory } from '#lib/settings/registry.js';

export interface SettingsSearchHit {
  category: SettingsCategory;
  setting: SettingDefinition;
}

export function searchSettings(
  query: string,
  categories: readonly SettingsCategory[],
  translate: (key: string) => string
): SettingsSearchHit[] {
  const term = query.trim().toLowerCase();
  if (!term) return [];

  const hits: SettingsSearchHit[] = [];
  for (const category of categories) {
    const categoryName = translate(category.name).toLowerCase();
    for (const setting of category.items) {
      if (setting.supported?.() === false) continue;

      const name = translate(setting.name).toLowerCase();
      const description = setting.description ? translate(setting.description).toLowerCase() : '';

      if (name.includes(term) || description.includes(term) || categoryName.includes(term)) {
        hits.push({ category, setting });
      }
    }
  }
  return hits;
}
