import CalendarBlankIcon from 'phosphor-svelte/lib/CalendarBlankIcon';
import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
import GlobeIcon from 'phosphor-svelte/lib/GlobeIcon';
import TranslateIcon from 'phosphor-svelte/lib/TranslateIcon';
import { setLanguage } from '#lib/i18n.js';
import { availableLocales, localeLabel, SYSTEM_LANGUAGE } from '#lib/locales.js';
import { SYSTEM_TIME_ZONE, timeZoneValues } from '#lib/ui/time-zones.js';
import type { SettingsCategory } from '../registry';

export const languageCategory: SettingsCategory = {
  id: 'language',
  name: 'settings.languageRegionTitle',
  icon: GlobeIcon,
  sections: [
    { id: 'app-language', name: 'settings.groups.language' },
    { id: 'time-date', name: 'settings.timeTitle' },
  ],
  items: [
    {
      key: 'language',
      section: 'app-language',
      icon: TranslateIcon,
      name: 'settings.language',
      terms: ['settings.terms.language'],
      type: 'select',
      options: [
        { value: SYSTEM_LANGUAGE, label: 'common.system' },
        ...availableLocales.map((code) => ({
          value: code,
          label: localeLabel(code),
          literal: true as const,
        })),
      ],
      onChange: (value) => {
        void setLanguage(value);
      },
    },
    {
      key: 'hour24Clock',
      section: 'time-date',
      icon: ClockIcon,
      name: 'settings.hour24Clock',
      terms: ['settings.terms.hour24Clock'],
      type: 'boolean',
    },
    {
      key: 'dateFormat',
      section: 'time-date',
      icon: CalendarBlankIcon,
      name: 'settings.dateFormat',
      type: 'select',
      options: [
        { value: 'auto', label: 'settings.dateFormatAuto' },
        { value: 'dmy', label: 'settings.dateFormatDmy' },
        { value: 'mdy', label: 'settings.dateFormatMdy' },
        { value: 'ymd', label: 'settings.dateFormatYmd' },
      ],
    },
    {
      key: 'timeZone',
      section: 'time-date',
      icon: GlobeIcon,
      name: 'settings.timeZone',
      description: 'settings.timeZoneHint',
      terms: ['settings.terms.timeZone'],
      type: 'select',
      options: timeZoneValues().map((zone) =>
        zone === SYSTEM_TIME_ZONE
          ? { value: zone, label: 'settings.timeZoneAuto' }
          : { value: zone, label: zone, literal: true }
      ),
    },
    {
      key: 'weekStart',
      section: 'time-date',
      icon: CalendarBlankIcon,
      name: 'settings.weekStart',
      terms: ['settings.terms.weekStart'],
      type: 'select',
      options: [
        { value: 'sunday', label: 'settings.weekStartSunday' },
        { value: 'monday', label: 'settings.weekStartMonday' },
        { value: 'saturday', label: 'settings.weekStartSaturday' },
      ],
    },
  ],
};
