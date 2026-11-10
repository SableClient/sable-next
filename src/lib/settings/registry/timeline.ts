import { accountDisablesReadReceipts } from '../preferences.svelte.js';
import ArrowsOutLineVerticalIcon from 'phosphor-svelte/lib/ArrowsOutLineVerticalIcon';
import ArrowLineDownIcon from 'phosphor-svelte/lib/ArrowLineDownIcon';
import CalendarBlankIcon from 'phosphor-svelte/lib/CalendarBlankIcon';
import ChatsCircleIcon from 'phosphor-svelte/lib/ChatsCircleIcon';
import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
import GlobeIcon from 'phosphor-svelte/lib/GlobeIcon';
import HandSwipeLeftIcon from 'phosphor-svelte/lib/HandSwipeLeftIcon';
import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
import LayoutIcon from 'phosphor-svelte/lib/LayoutIcon';
import DatabaseIcon from 'phosphor-svelte/lib/DatabaseIcon';
import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
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
import { currentLocale } from '#lib/i18n.js';
import { SYSTEM_TIME_ZONE, timeZoneValues } from '#lib/ui/time-zones.js';
import { isNativeMobile, supportsTouch } from '#lib/platform/os.js';
import {
  SEARCH_BASE_EVENTS,
  SEARCH_BATCH_SIZES,
  SEARCH_CRAWL_PAUSES,
  SEARCH_FLUSH_INTERVALS,
  SEARCH_INDEX_LIMITS,
  SEARCH_MAX_EVENTS,
  SEARCH_TRICKLE_PAUSES,
} from '../definitions';
import type { SettingsCategory } from '../registry';

export const timelineCategory: SettingsCategory = {
  id: 'timeline',
  name: 'settings.timelineTitle',
  icon: ChatsCircleIcon,
  sections: [
    { id: 'message-layout', name: 'settings.groups.messageLayout' },
    { id: 'messages', name: 'settings.groups.messages' },
    { id: 'time-date', name: 'settings.timeTitle' },
    { id: 'room-events', name: 'settings.groups.roomEvents' },
    { id: 'receipts-typing', name: 'settings.groups.receiptsTyping' },
    { id: 'members-pronouns', name: 'settings.groups.membersPronouns' },
    { id: 'message-search', name: 'settings.groups.messageSearch' },
    { id: 'developer-search-metrics', name: 'settings.developerSearchTitle' },
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
      key: 'showSearch',
      section: 'message-search',
      icon: MagnifyingGlassIcon,
      name: 'settings.showSearch',
      type: 'boolean',
    },
    {
      key: 'searchCrawler',
      section: 'message-search',
      icon: DatabaseIcon,
      name: 'settings.searchCrawler',
      description: 'settings.searchCrawlerHint',
      type: 'boolean',
    },
    {
      key: 'searchUnmeteredOnly',
      section: 'message-search',
      icon: DatabaseIcon,
      name: 'settings.searchUnmeteredOnly',
      description: 'settings.searchUnmeteredOnlyHint',
      type: 'boolean',
      supported: isNativeMobile,
    },
    {
      key: 'searchSharing',
      section: 'message-search',
      icon: DatabaseIcon,
      name: 'settings.searchSharing',
      description: 'settings.searchSharingHint',
      type: 'boolean',
    },
    {
      key: 'serverSearch',
      section: 'message-search',
      icon: MagnifyingGlassIcon,
      name: 'settings.serverSearch',
      description: 'settings.serverSearchHint',
      type: 'boolean',
    },
    {
      key: 'searchIndexLimit',
      section: 'message-search',
      icon: DatabaseIcon,
      name: 'settings.searchIndexLimit',
      type: 'select',
      options: SEARCH_INDEX_LIMITS.map((limit) => ({
        value: limit,
        label: Number(limit) >= 1024 ? `${String(Number(limit) / 1024)} GiB` : `${limit} MiB`,
        literal: true,
      })),
    },
    {
      key: 'searchCrawlPause',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchCrawlPause',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_CRAWL_PAUSES.map((value) => ({
        value,
        label: `${value} s`,
        literal: true,
      })),
    },
    {
      key: 'searchTricklePause',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchTricklePause',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_TRICKLE_PAUSES.map((value) => ({
        value,
        label: `${value} s`,
        literal: true,
      })),
    },
    {
      key: 'searchFlushInterval',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchFlushInterval',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_FLUSH_INTERVALS.map((value) => ({
        value,
        label: `${value} s`,
        literal: true,
      })),
    },
    {
      key: 'searchBatchSize',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchBatchSize',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_BATCH_SIZES.map((value) => ({
        value,
        get label() {
          return `${Number(value).toLocaleString(currentLocale())} events`;
        },
        literal: true,
      })),
    },
    {
      key: 'searchBaseEvents',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchBaseEvents',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_BASE_EVENTS.map((value) => ({
        value,
        get label() {
          return `${Number(value).toLocaleString(currentLocale())} events`;
        },
        literal: true,
      })),
    },
    {
      key: 'searchMaxEvents',
      section: 'developer-search-metrics',
      icon: DatabaseIcon,
      name: 'settings.searchMaxEvents',
      type: 'select',
      gatedBy: 'developerTools',
      options: SEARCH_MAX_EVENTS.map((value) => ({
        value,
        get label() {
          return `${Number(value).toLocaleString(currentLocale())} events`;
        },
        literal: true,
      })),
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
      key: 'doubleTapReact',
      section: 'messages',
      icon: HeartIcon,
      name: 'settings.doubleTapReact',
      type: 'boolean',
      supported: supportsTouch,
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
