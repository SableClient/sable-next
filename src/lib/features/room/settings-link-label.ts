import { t } from '$lib/i18n';
import { findCategory, findSettingByFocusId } from '$lib/settings/registry';

import type { SettingsLink } from './settings-link';

export function settingsLinkLabel(link: SettingsLink): string {
  const owner = link.focus === undefined ? undefined : findSettingByFocusId(link.focus);
  const category = owner?.category ?? findCategory(link.section);
  const section = category ? t(category.name) : t('settings.security');

  return owner ? `${section} / ${t(owner.setting.name)}` : section;
}
