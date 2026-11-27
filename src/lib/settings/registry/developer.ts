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
  tabs: [
    { id: 'overview', name: 'settings.developerTabOverview' },
    { id: 'data', name: 'settings.developerTabData' },
    { id: 'notifications', name: 'settings.developerTabNotifications' },
    { id: 'logs', name: 'settings.developerTabLogs' },
  ],
  sections: [
    { id: 'developer-status', name: 'settings.developerStatusTitle' },
    { id: 'developer-options', name: 'common.developerTools' },
    { id: 'developer-account-data', name: 'settings.developerAccountDataTitle', tab: 'data' },
    { id: 'developer-push-rules', name: 'settings.developerPushRulesTitle', tab: 'data' },
    { id: 'settings-state-event', name: 'settings.stateEventTitle', tab: 'data' },
    {
      id: 'developer-notifications',
      name: 'settings.developerNotificationsTitle',
      tab: 'notifications',
    },
    { id: 'developer-debug-logs', name: 'settings.developerLogsTitle', tab: 'logs' },
    { id: 'developer-sentry', name: 'settings.developerSentryTitle', tab: 'logs' },
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
      requiresReload: true,
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
      shownWhen: { key: 'showHiddenEvents', value: true },
    },
    {
      key: 'hiddenEventReactions',
      section: 'developer-options',
      icon: SmileyIcon,
      name: 'settings.hiddenEventReactions',
      type: 'boolean',
      shownWhen: { key: 'showHiddenEvents', value: true },
    },
    {
      key: 'hiddenEventRedactions',
      section: 'developer-options',
      icon: TrashIcon,
      name: 'settings.hiddenEventRedactions',
      type: 'boolean',
      shownWhen: { key: 'showHiddenEvents', value: true },
    },
    {
      key: 'hiddenEventOther',
      section: 'developer-options',
      icon: DotsThreeIcon,
      name: 'settings.hiddenEventOther',
      type: 'boolean',
      shownWhen: { key: 'showHiddenEvents', value: true },
    },
    {
      key: 'showTranslationStrings',
      section: 'developer-options',
      icon: TranslateIcon,
      name: 'settings.showTranslationStrings',
      type: 'boolean',
      gatedBy: 'developerTools',
    },
    {
      key: 'showAlertZoo',
      section: 'developer-options',
      icon: CodeIcon,
      name: 'settings.showAlertZoo',
      type: 'boolean',
      gatedBy: 'developerTools',
    },
  ],
};
