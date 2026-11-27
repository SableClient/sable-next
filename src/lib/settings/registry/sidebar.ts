import BridgeIcon from 'phosphor-svelte/lib/BridgeIcon';
import CalendarBlankIcon from 'phosphor-svelte/lib/CalendarBlankIcon';
import ChatTextIcon from 'phosphor-svelte/lib/ChatTextIcon';
import ChatsCircleIcon from 'phosphor-svelte/lib/ChatsCircleIcon';
import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
import DotIcon from 'phosphor-svelte/lib/DotIcon';
import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
import MegaphoneIcon from 'phosphor-svelte/lib/MegaphoneIcon';
import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';
import SidebarSimpleIcon from 'phosphor-svelte/lib/SidebarSimpleIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
import ThreadIcon from 'phosphor-svelte/lib/ScribbleLoopIcon';
import TreeStructureIcon from 'phosphor-svelte/lib/TreeStructureIcon';
import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
import { SUBSPACE_DEPTHS } from '../definitions';
import type { SettingsCategory } from '../registry';

export const sidebarCategory: SettingsCategory = {
  id: 'sidebar',
  name: 'settings.groups.sidebar',
  icon: SidebarSimpleIcon,
  sections: [
    { id: 'sidebar', name: 'settings.groups.roomList' },
    { id: 'room-icons', name: 'settings.groups.roomIcons' },
    { id: 'unread-badges', name: 'settings.groups.unreadBadges' },
  ],
  items: [
    {
      key: 'showHome',
      section: 'sidebar',
      icon: HouseIcon,
      name: 'settings.showHome',
      type: 'boolean',
    },
    {
      key: 'restoreLastRoom',
      section: 'sidebar',
      icon: ClockIcon,
      name: 'settings.restoreLastRoom',
      description: 'settings.restoreLastRoomHint',
      type: 'boolean',
    },
    {
      key: 'subspaceHierarchyLimit',
      section: 'sidebar',
      icon: TreeStructureIcon,
      name: 'settings.subspaceHierarchyLimit',
      type: 'select',
      options: SUBSPACE_DEPTHS.map((depth) => ({ value: depth, label: depth, literal: true })),
    },
    {
      key: 'messagePreviews',
      section: 'sidebar',
      icon: ChatTextIcon,
      name: 'settings.messagePreviews',
      description: 'settings.messagePreviewsHint',
      type: 'select',
      options: [
        { value: 'off', label: 'settings.messagePreviewsOff' },
        { value: 'direct', label: 'settings.messagePreviewsDirect' },
        { value: 'rooms', label: 'settings.messagePreviewsRooms' },
        { value: 'all', label: 'settings.messagePreviewsAll' },
      ],
    },
    {
      key: 'showDmTopics',
      section: 'sidebar',
      icon: ChatTextIcon,
      name: 'settings.showDmTopics',
      description: 'settings.showDmTopicsHint',
      type: 'boolean',
    },
    {
      key: 'showRoomBanners',
      section: 'sidebar',
      icon: ImageIcon,
      name: 'settings.showRoomBanners',
      type: 'boolean',
    },
    {
      key: 'bannerFit',
      section: 'sidebar',
      icon: ImageIcon,
      name: 'settings.bannerFit',
      description: 'settings.bannerFitHint',
      type: 'select',
      options: [
        { value: 'fixed', label: 'settings.bannerFitFixed' },
        { value: 'image', label: 'settings.bannerFitImage' },
      ],
    },
    {
      key: 'showSpaceEvents',
      section: 'sidebar',
      icon: CalendarBlankIcon,
      name: 'settings.showSpaceEvents',
      type: 'boolean',
    },
    {
      key: 'showActiveThreadsInSidebar',
      section: 'sidebar',
      icon: ThreadIcon,
      name: 'settings.showActiveThreadsInSidebar',
      type: 'boolean',
    },
    {
      key: 'voiceParticipantPlacement',
      section: 'sidebar',
      icon: UsersIcon,
      name: 'settings.voiceParticipantPlacement',
      type: 'select',
      options: [
        { value: 'both', label: 'settings.voiceParticipantsBoth' },
        { value: 'below', label: 'settings.voiceParticipantsBelow' },
        { value: 'inline', label: 'settings.voiceParticipantsInline' },
      ],
    },
    {
      key: 'showRoomIcon',
      section: 'room-icons',
      icon: ImageIcon,
      name: 'settings.showRoomIcon',
      type: 'select',
      options: [
        { value: 'always', label: 'common.always' },
        { value: 'sometimes', label: 'settings.showRoomIconSometimes' },
        { value: 'collapsed', label: 'settings.showRoomIconCollapsed' },
        { value: 'never', label: 'common.never' },
      ],
    },
    {
      key: 'uniformIcons',
      section: 'room-icons',
      icon: SquaresFourIcon,
      name: 'settings.uniformIcons',
      type: 'boolean',
    },
    {
      key: 'tintRoomIcons',
      section: 'room-icons',
      icon: PaletteIcon,
      name: 'settings.tintRoomIcons',
      description: 'settings.tintRoomIconsHint',
      type: 'boolean',
    },
    {
      key: 'showBridgeBadges',
      section: 'room-icons',
      icon: BridgeIcon,
      name: 'settings.showBridgeBadges',
      type: 'boolean',
    },
    {
      key: 'showUnreadCounts',
      section: 'unread-badges',
      icon: ChatTextIcon,
      name: 'settings.showUnreadCounts',
      type: 'boolean',
    },
    {
      key: 'badgeCountDMsOnly',
      section: 'unread-badges',
      icon: ChatsCircleIcon,
      name: 'settings.badgeCountDMsOnly',
      type: 'boolean',
    },
    {
      key: 'showEasterEggs',
      section: 'unread-badges',
      icon: SmileyIcon,
      name: 'settings.showEasterEggs',
      type: 'boolean',
    },
    {
      key: 'showPingCounts',
      section: 'unread-badges',
      icon: MegaphoneIcon,
      name: 'settings.showPingCounts',
      type: 'boolean',
    },
    {
      key: 'showUnreadDots',
      section: 'unread-badges',
      icon: DotIcon,
      name: 'settings.showUnreadDots',
      type: 'boolean',
    },
  ],
};
