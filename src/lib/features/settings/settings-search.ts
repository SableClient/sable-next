import {
  settingsTargets,
  type SettingsTargetDefinition,
  type SettingsCategory,
  type SettingsContext,
  type SettingOption,
} from '#lib/settings/registry.js';

export interface SettingsSearchHit {
  category: SettingsCategory;
  setting: SettingsTargetDefinition;
}

export function searchSettings(
  query: string,
  categories: readonly SettingsCategory[],
  translate: (key: string) => string,
  context: SettingsContext
): SettingsSearchHit[] {
  const term = query.trim().toLowerCase();
  if (!term) return [];

  const hits: SettingsSearchHit[] = [];
  for (const category of categories) {
    const categoryName = translate(category.name).toLowerCase();
    for (const setting of settingsTargets(category)) {
      if (setting.supported?.(context) === false) continue;

      const name = translate(setting.name).toLowerCase();
      const description = setting.description ? translate(setting.description).toLowerCase() : '';
      const terms = setting.terms?.map((key) => translate(key).toLowerCase()) ?? [];
      if ('options' in setting) {
        for (const option of setting.options as SettingOption[]) {
          terms.push((option.literal ? option.label : translate(option.label)).toLowerCase());
        }
      }

      if (
        name.includes(term) ||
        description.includes(term) ||
        categoryName.includes(term) ||
        terms.some((entry) => entry.includes(term))
      ) {
        hits.push({ category, setting });
      }
    }
  }
  return hits;
}
