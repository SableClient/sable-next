import { accountDisablesReadReceipts } from '../preferences.svelte.js';
import ArrowsOutLineVerticalIcon from 'phosphor-svelte/lib/ArrowsOutLineVerticalIcon';
import ArrowLineDownIcon from 'phosphor-svelte/lib/ArrowLineDownIcon';
import ChatsCircleIcon from 'phosphor-svelte/lib/ChatsCircleIcon';
import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
import HandSwipeLeftIcon from 'phosphor-svelte/lib/HandSwipeLeftIcon';
import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
import LayoutIcon from 'phosphor-svelte/lib/LayoutIcon';
import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
import MegaphoneIcon from 'phosphor-svelte/lib/MegaphoneIcon';
import PaperPlaneTiltIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
import QuotesIcon from 'phosphor-svelte/lib/QuotesIcon';
import ShieldIcon from 'phosphor-svelte/lib/ShieldIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
import TextAlignLeftIcon from 'phosphor-svelte/lib/TextAlignLeftIcon';
import TranslateIcon from 'phosphor-svelte/lib/TranslateIcon';
import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
import UserCircleIcon from 'phosphor-svelte/lib/UserCircleIcon';
import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
import { supportsTouch } from '#lib/platform/os.js';
import type { SettingsCategory } from '../registry';

export const timelineCategory: SettingsCategory = {
  id: 'timeline',
  name: 'settings.timelineTitle',
  icon: ChatsCircleIcon,
  sections: [
    { id: 'message-layout', name: 'settings.groups.messageLayout' },
    { id: 'messages', name: 'settings.groups.messages' },
    { id: 'room-events', name: 'settings.groups.roomEvents' },
    { id: 'receipts-typing', name: 'settings.groups.receiptsTyping' },
    { id: 'members-pronouns', name: 'settings.groups.membersPronouns' },
  ],
  items: [
    {
      key: 'layout',
      section: 'message-layout',
      icon: LayoutIcon,
      name: 'settings.layout',
      description: 'settings.layoutHint',
      type: 'select',
      options: [
        { value: 'modern', label: 'settings.layoutModern' },
        { value: 'compact', label: 'settings.layoutCompact' },
        { value: 'bubble', label: 'settings.layoutBubble' },
      ],
    },
    {
      key: 'threadPresentation',
      section: 'message-layout',
      icon: LayoutIcon,
      name: 'settings.threadPresentation',
      description: 'settings.threadPresentationHint',
      type: 'select',
      options: [
        { value: 'timeline', label: 'settings.threadPresentationTimeline' },
        { value: 'panel', label: 'settings.threadPresentationPanel' },
      ],
    },
    {
      key: 'alignOwnMessages',
      section: 'message-layout',
      icon: LayoutIcon,
      name: 'settings.alignOwnMessages',
      description: 'settings.alignOwnMessagesHint',
      type: 'boolean',
    },
    {
      key: 'showAllTimestamps',
      section: 'message-layout',
      icon: ClockIcon,
      name: 'settings.showAllTimestamps',
      type: 'boolean',
    },
    {
      key: 'avatarsInMessageHeaders',
      section: 'message-layout',
      icon: LayoutIcon,
      name: 'settings.avatarsInMessageHeaders',
      description: 'settings.avatarsInMessageHeadersHint',
      type: 'boolean',
    },
    {
      key: 'messageSpacing',
      section: 'message-layout',
      icon: ArrowsOutLineVerticalIcon,
      name: 'settings.messageSpacing',
      type: 'select',
      options: [
        { value: 'none', label: 'settings.spacingNone' },
        { value: 'compact', label: 'settings.spacingCompact' },
        { value: 'cozy', label: 'settings.spacingCozy' },
        { value: 'roomy', label: 'settings.spacingRoomy' },
      ],
    },
    {
      key: 'openRoomsAtUnread',
      section: 'messages',
      icon: ArrowLineDownIcon,
      name: 'settings.openRoomsAtUnread',
      description: 'settings.openRoomsAtUnreadHint',
      type: 'boolean',
    },
    {
      key: 'jumpToLatestOnSend',
      section: 'messages',
      icon: PaperPlaneTiltIcon,
      name: 'settings.jumpToLatestOnSend',
      description: 'settings.jumpToLatestOnSendHint',
      type: 'boolean',
    },
    {
      key: 'timelineEmoteSize',
      section: 'messages',
      icon: SmileyIcon,
      name: 'settings.timelineEmoteSize',
      type: 'select',
      options: [
        { value: 'default', label: 'settings.timelineEmoteSizeDefault' },
        { value: '20', label: '20 px', literal: true },
        { value: '24', label: '24 px', literal: true },
        { value: '32', label: '32 px', literal: true },
        { value: '48', label: '48 px', literal: true },
        { value: '64', label: '64 px', literal: true },
      ],
    },
    {
      key: 'replyPreviewStyle',
      section: 'messages',
      icon: QuotesIcon,
      name: 'settings.replyPreviewStyle',
      type: 'select',
      options: [
        { value: 'connected', label: 'settings.replyPreviewStyleConnected' },
        { value: 'compact', label: 'settings.replyPreviewStyleCompact' },
        { value: 'expanded', label: 'settings.replyPreviewStyleExpanded' },
      ],
    },
    {
      key: 'captionPosition',
      section: 'messages',
      icon: TextAlignLeftIcon,
      name: 'settings.captionPosition',
      type: 'select',
      options: [
        { value: 'above', label: 'settings.captionPositionAbove' },
        { value: 'below', label: 'settings.captionPositionBelow' },
        { value: 'inline', label: 'settings.captionPositionInline' },
        { value: 'hidden', label: 'settings.captionPositionHidden' },
      ],
    },
    {
      key: 'usernameClick',
      section: 'messages',
      icon: UserCircleIcon,
      name: 'settings.usernameClick',
      type: 'select',
      options: [
        { value: 'mention', label: 'settings.usernameClickMention' },
        { value: 'profile', label: 'settings.usernameClickProfile' },
      ],
    },
    {
      key: 'showSingleReactionCount',
      section: 'messages',
      icon: SmileyIcon,
      name: 'settings.showSingleReactionCount',
      type: 'boolean',
    },
    {
      key: 'showRoleTooltip',
      section: 'messages',
      icon: UserCircleIcon,
      name: 'settings.showRoleTooltip',
      type: 'boolean',
    },
    {
      key: 'hideMessageShields',
      section: 'messages',
      icon: ShieldIcon,
      name: 'settings.hideMessageShields',
      description: 'settings.hideMessageShieldsHint',
      type: 'boolean',
    },
    {
      key: 'messageSwipeAction',
      section: 'messages',
      icon: HandSwipeLeftIcon,
      name: 'settings.messageSwipeAction',
      type: 'select',
      options: [
        { value: 'reply', label: 'settings.messageSwipeActionReply' },
        { value: 'members', label: 'settings.messageSwipeActionMembers' },
      ],
      supported: supportsTouch,
    },
    {
      key: 'doubleTapReact',
      section: 'messages',
      icon: HeartIcon,
      name: 'settings.doubleTapReact',
      type: 'boolean',
      supported: supportsTouch,
    },
    {
      key: 'hideMembershipEvents',
      section: 'room-events',
      icon: UsersIcon,
      name: 'settings.hideMembershipEvents',
      type: 'boolean',
    },
    {
      key: 'hideProfileChanges',
      section: 'room-events',
      icon: UserCircleIcon,
      name: 'settings.hideProfileChanges',
      type: 'boolean',
    },
    {
      key: 'hideTopicChanges',
      section: 'room-events',
      icon: TextAlignLeftIcon,
      name: 'settings.hideTopicChanges',
      type: 'boolean',
    },
    {
      key: 'hideSentBeforeJoined',
      section: 'room-events',
      icon: LockSimpleIcon,
      name: 'settings.hideSentBeforeJoined',
      description: 'settings.hideSentBeforeJoinedHint',
      type: 'boolean',
    },
    {
      key: 'hideMemberInReadOnly',
      section: 'room-events',
      icon: MegaphoneIcon,
      name: 'settings.hideMemberInReadOnly',
      type: 'boolean',
    },
    {
      key: 'showTombstoneEvents',
      section: 'room-events',
      icon: TrashIcon,
      name: 'settings.showTombstoneEvents',
      type: 'boolean',
    },
    {
      key: 'hideReadReceipts',
      supported: () => !accountDisablesReadReceipts(),
      section: 'receipts-typing',
      icon: ChecksIcon,
      name: 'settings.hideReadReceipts',
      terms: ['settings.terms.hideReadReceipts'],
      description: 'settings.hideReadReceiptsHint',
      type: 'boolean',
    },
    {
      key: 'readReceiptPlacement',
      section: 'receipts-typing',
      icon: ChecksIcon,
      name: 'settings.readReceiptPlacement',
      type: 'select',
      options: [
        { value: 'message', label: 'settings.readReceiptPlacementMessage' },
        { value: 'room', label: 'settings.readReceiptPlacementRoom' },
      ],
    },
    {
      key: 'hideTypingIndicators',
      section: 'receipts-typing',
      icon: DotsThreeIcon,
      name: 'settings.hideTypingIndicators',
      terms: ['settings.terms.typing'],
      type: 'boolean',
    },
    {
      key: 'groupMembersByPresence',
      section: 'members-pronouns',
      icon: UsersIcon,
      name: 'settings.groupMembersByPresence',
      type: 'boolean',
    },
    {
      key: 'showPronouns',
      section: 'members-pronouns',
      icon: UserCircleIcon,
      name: 'settings.showPronouns',
      type: 'boolean',
    },
    {
      key: 'showPronounPills',
      section: 'members-pronouns',
      icon: UserCircleIcon,
      name: 'settings.showPronounPills',
      type: 'boolean',
      gatedBy: 'showPronouns',
    },
    {
      key: 'filterPronounsByLanguage',
      section: 'members-pronouns',
      icon: TranslateIcon,
      name: 'settings.filterPronounsByLanguage',
      type: 'boolean',
      gatedBy: 'showPronouns',
    },
    {
      key: 'pronounPillLimit',
      section: 'members-pronouns',
      icon: UserCircleIcon,
      name: 'settings.pronounPillLimit',
      type: 'select',
      options: [
        { value: '1', label: 'settings.pronounPillLimitOne' },
        { value: '2', label: 'settings.pronounPillLimitTwo' },
        { value: '3', label: 'settings.pronounPillLimitThree' },
        { value: 'all', label: 'settings.pronounPillLimitAll' },
      ],
      gatedBy: 'showPronouns',
    },
    {
      key: 'pronounPillLength',
      section: 'members-pronouns',
      icon: TextAaIcon,
      name: 'settings.pronounPillLength',
      type: 'select',
      gatedBy: 'showPronouns',
      options: [
        { value: '12', label: '12' },
        { value: '16', label: '16' },
        { value: '24', label: '24' },
        { value: 'all', label: 'settings.pronounPillLengthAll' },
      ],
    },
  ],
};
