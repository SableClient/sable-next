import AtIcon from 'phosphor-svelte/lib/AtIcon';
import BellIcon from 'phosphor-svelte/lib/BellIcon';
import BellSimpleIcon from 'phosphor-svelte/lib/BellSimpleIcon';
import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
import ChatTextIcon from 'phosphor-svelte/lib/ChatTextIcon';
import DevicesIcon from 'phosphor-svelte/lib/DevicesIcon';
import LockIcon from 'phosphor-svelte/lib/LockIcon';
import PaperPlaneTiltIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
import { presentsInApp, pushPlatform } from '#lib/platform/notifications.js';
import { PUSH_INACTIVE_TIMEOUTS } from '../definitions';
import type { SettingOption, SettingsCategory } from '../registry';

const pushInactiveTimeoutOptions: SettingOption[] = PUSH_INACTIVE_TIMEOUTS.map((value) =>
  value === 'off'
    ? { value, label: 'common.always' }
    : { value, label: `${value} min`, literal: true }
);

export const notificationsCategory: SettingsCategory = {
  id: 'notifications',
  name: 'settings.notificationsTitle',
  icon: BellIcon,
  sections: [
    { id: 'alerts', name: 'settings.groups.systemNotifications' },
    { id: 'sounds', name: 'settings.groups.sounds' },
    { id: 'highlights', name: 'settings.groups.highlights' },
  ],
  items: [
    {
      key: 'systemNotifications',
      section: 'alerts',
      icon: BellIcon,
      name: 'settings.systemNotifications',
      type: 'boolean',
    },
    {
      key: 'notificationContent',
      section: 'alerts',
      icon: ChatTextIcon,
      name: 'settings.notificationContent',
      description: 'settings.notificationContentHint',
      type: 'boolean',
      gatedBy: 'systemNotifications',
    },
    {
      key: 'notificationEncryptedContent',
      section: 'alerts',
      icon: LockIcon,
      name: 'settings.notificationEncryptedContent',
      description: 'settings.notificationEncryptedContentHint',
      type: 'boolean',
      gatedBy: 'notificationContent',
    },
    {
      key: 'notifyOnce',
      section: 'alerts',
      icon: BellSimpleIcon,
      name: 'settings.notifyOnce',
      type: 'boolean',
    },
    {
      key: 'pushInactiveTimeout',
      section: 'alerts',
      icon: DevicesIcon,
      name: 'settings.pushInactiveTimeout',
      description: 'settings.pushInactiveTimeoutHint',
      type: 'select',
      options: pushInactiveTimeoutOptions,
      gatedBy: 'sendPresence',
    },
    {
      key: 'clearNotificationsOnRead',
      section: 'alerts',
      icon: CheckCircleIcon,
      name: 'settings.clearNotificationsOnRead',
      type: 'boolean',
    },
    {
      key: 'richPushPayloads',
      section: 'alerts',
      icon: PaperPlaneTiltIcon,
      name: 'settings.richPushPayloads',
      description: 'settings.richPushPayloadsHint',
      type: 'boolean',
      supported: () => pushPlatform() !== 'ios',
    },
    {
      key: 'notificationSounds',
      section: 'sounds',
      icon: SpeakerHighIcon,
      name: 'settings.notificationSounds',
      terms: ['settings.terms.notificationSounds'],
      type: 'boolean',
    },
    {
      key: 'backgroundNotificationSounds',
      section: 'sounds',
      icon: SpeakerHighIcon,
      name: 'settings.backgroundNotificationSounds',
      type: 'boolean',
      gatedBy: 'notificationSounds',
      supported: presentsInApp,
    },
    {
      key: 'highlightMentions',
      section: 'highlights',
      icon: AtIcon,
      name: 'settings.highlightMentions',
      type: 'boolean',
    },
    {
      key: 'faviconForMentionsOnly',
      section: 'highlights',
      icon: AtIcon,
      name: 'settings.faviconForMentionsOnly',
      type: 'boolean',
    },
  ],
};
