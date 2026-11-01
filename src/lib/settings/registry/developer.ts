import BugIcon from 'phosphor-svelte/lib/BugIcon';
import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
import MonitorIcon from 'phosphor-svelte/lib/MonitorIcon';
import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
import type { SettingsCategory } from '../registry';
import TranslateIcon from 'phosphor-svelte/lib/TranslateIcon';

export const developerCategory: SettingsCategory = {
  id: 'developer',
  name: 'settings.developerTitle',
  icon: CodeIcon,
  sections: [
    { id: 'developer-options', name: 'common.developerTools' },
    { id: 'developer-sync-diagnostics', name: 'settings.developerSyncTitle' },
    { id: 'developer-server-features', name: 'settings.developerServerFeaturesTitle' },
    { id: 'developer-account-data', name: 'settings.developerAccountDataTitle' },
    { id: 'developer-push-rules', name: 'settings.developerPushRulesTitle' },
    { id: 'developer-notifications', name: 'settings.developerNotificationsTitle' },
    { id: 'developer-debug-logs', name: 'settings.developerLogsTitle' },
    { id: 'developer-sentry', name: 'settings.developerSentryTitle' },
    { id: 'settings-state-event', name: 'settings.stateEventTitle' },
  ],
  items: [
    {
      key: 'developerTools',
      section: 'developer-options',
      icon: CodeIcon,
      name: 'settings.developerTools',
      type: 'boolean',
    },
    {
      key: 'coreLogLevel',
      section: 'developer-options',
      icon: CodeIcon,
      name: 'settings.coreLogLevel',
      description: 'settings.coreLogLevelHint',
      type: 'select',
      gatedBy: 'developerTools',
      options: [
        { value: 'default', label: 'settings.coreLogLevelDefault' },
        { value: 'debug', label: 'settings.coreLogLevelDebug' },
      ],
    },
    {
      key: 'callStatsOverlay',
      section: 'developer-options',
      icon: MonitorIcon,
      name: 'settings.callStatsOverlay',
      type: 'boolean',
      gatedBy: 'developerTools',
    },
    {
      key: 'callDebugOverlay',
      section: 'developer-options',
      icon: PhoneIcon,
      name: 'settings.callDebugOverlay',
      type: 'boolean',
      gatedBy: 'developerTools',
    },
    {
      key: 'showHiddenEvents',
      section: 'developer-options',
      icon: BugIcon,
      name: 'settings.showHiddenEvents',
      type: 'boolean',
      gatedBy: 'developerTools',
    },
    {
      key: 'hiddenEventsHeaderToggle',
      section: 'developer-options',
      icon: EyeIcon,
      name: 'settings.hiddenEventsHeaderToggle',
      type: 'boolean',
      gatedBy: 'developerTools',
    },
    {
      key: 'hiddenEventEdits',
      section: 'developer-options',
      icon: PencilSimpleIcon,
      name: 'settings.hiddenEventEdits',
      type: 'boolean',
      gatedBy: 'showHiddenEvents',
    },
    {
      key: 'hiddenEventReactions',
      section: 'developer-options',
      icon: SmileyIcon,
      name: 'settings.hiddenEventReactions',
      type: 'boolean',
      gatedBy: 'showHiddenEvents',
    },
    {
      key: 'hiddenEventRedactions',
      section: 'developer-options',
      icon: TrashIcon,
      name: 'settings.hiddenEventRedactions',
      type: 'boolean',
      gatedBy: 'showHiddenEvents',
    },
    {
      key: 'hiddenEventOther',
      section: 'developer-options',
      icon: DotsThreeIcon,
      name: 'settings.hiddenEventOther',
      type: 'boolean',
      gatedBy: 'showHiddenEvents',
    },
    {
      key: 'showTranslationStrings',
      section: 'developer-options',
      icon: TranslateIcon,
      name: 'settings.showTranslationStrings',
      type: 'boolean',
      gatedBy: 'developerTools',
    },
  ],
};
