import { accountDisablesReadReceipts } from '../preferences.svelte.js';
import BugIcon from 'phosphor-svelte/lib/BugIcon';
import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
import EyeSlashIcon from 'phosphor-svelte/lib/EyeSlashIcon';
import FilmStripIcon from 'phosphor-svelte/lib/FilmStripIcon';
import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
import KeyboardIcon from 'phosphor-svelte/lib/KeyboardIcon';
import PulseIcon from 'phosphor-svelte/lib/PulseIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
import { syncTelemetryConsent } from '#lib/platform/telemetry.js';
import { setPreference } from '../preferences.svelte';
import type { SettingDefinition, SettingsCategory } from '../registry';

/** A build without a DSN has no error reporting to offer, so the rows are absent. */
const telemetrySettings: SettingDefinition[] = import.meta.env.VITE_SENTRY_DSN
  ? [
      {
        key: 'errorReporting',
        section: 'diagnostics',
        icon: BugIcon,
        name: 'settings.errorReporting',
        terms: ['settings.terms.errorReporting'],
        description: 'settings.errorReportingHint',
        type: 'boolean',
        requiresReload: true,
        onChange: (value) => {
          setPreference('telemetryAsked', true);
          syncTelemetryConsent(value);
        },
      },
      {
        key: 'sessionReplay',
        section: 'diagnostics',
        icon: FilmStripIcon,
        name: 'settings.sessionReplay',
        description: 'settings.sessionReplayHint',
        type: 'boolean',
        gatedBy: 'errorReporting',
        requiresReload: true,
        onChange: () => {
          setPreference('telemetryAsked', true);
        },
      },
    ]
  : [];

export const privacyCategory: SettingsCategory = {
  id: 'privacy',
  name: 'settings.privacyTitle',
  icon: EyeSlashIcon,
  sections: [
    { id: 'activity', name: 'settings.groups.activity' },
    { id: 'online-status', name: 'settings.groups.presenceSharing' },
    { id: 'blurring', name: 'settings.groups.blurring' },
    { id: 'diagnostics', name: 'settings.groups.diagnostics' },
  ],
  items: [
    {
      key: 'sendTypingNotifications',
      section: 'activity',
      icon: KeyboardIcon,
      name: 'settings.sendTypingNotifications',
      terms: ['settings.terms.typing'],
      type: 'boolean',
    },
    {
      key: 'sendReadReceipts',
      supported: () => !accountDisablesReadReceipts(),
      section: 'activity',
      icon: EyeIcon,
      name: 'common.readReceipts',
      terms: ['settings.terms.sendReadReceipts'],
      description: 'settings.sendReadReceiptsHint',
      type: 'boolean',
    },
    {
      key: 'sendPresence',
      section: 'activity',
      icon: PulseIcon,
      name: 'settings.sendPresence',
      terms: ['settings.terms.sendPresence'],
      description: 'settings.sendPresenceHint',
      type: 'boolean',
    },
    {
      key: 'blurMedia',
      section: 'blurring',
      icon: ImageIcon,
      name: 'settings.blurMedia',
      terms: ['settings.terms.blurMedia'],
      type: 'boolean',
    },
    {
      key: 'blurAvatars',
      section: 'blurring',
      icon: UserCircleIcon,
      name: 'settings.blurAvatars',
      type: 'boolean',
    },
    {
      key: 'blurEmotes',
      section: 'blurring',
      icon: SmileyIcon,
      name: 'settings.blurEmotes',
      type: 'boolean',
    },
    ...telemetrySettings,
  ],
};
