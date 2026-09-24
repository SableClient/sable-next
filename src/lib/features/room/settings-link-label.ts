import { t } from '#lib/i18n.js';
import {
  findCategory,
  findSettingByFocusId,
  findSettingsSection,
  STANDALONE_PAGE_NAMES,
} from '#lib/settings/registry.js';

import type { SettingsLink } from './settings-link';

export function settingsLinkLabel(link: SettingsLink): string {
  const owner = link.focus === undefined ? undefined : findSettingByFocusId(link.focus);
  const section = link.focus === undefined ? undefined : findSettingsSection(link.focus);
  const category = owner?.category ?? findCategory(link.section);
  const page = t(category?.name ?? STANDALONE_PAGE_NAMES[link.section] ?? 'settings.security');

  if (owner) return `${page} / ${t(owner.setting.name)}`;
  if (section && section.category === category) return `${page} / ${t(section.section.name)}`;
  return page;
}
