import BridgeIcon from 'phosphor-svelte/lib/BridgeIcon';
import CalendarBlankIcon from 'phosphor-svelte/lib/CalendarBlankIcon';
import ChatTextIcon from 'phosphor-svelte/lib/ChatTextIcon';
import ChatsCircleIcon from 'phosphor-svelte/lib/ChatsCircleIcon';
import CircleHalfIcon from 'phosphor-svelte/lib/CircleHalfIcon';
import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
import DotIcon from 'phosphor-svelte/lib/DotIcon';
import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
import HouseIcon from 'phosphor-svelte/lib/HouseIcon';
import ImageIcon from 'phosphor-svelte/lib/ImageIcon';
import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
import MagnifyingGlassPlusIcon from 'phosphor-svelte/lib/MagnifyingGlassPlusIcon';
import MegaphoneIcon from 'phosphor-svelte/lib/MegaphoneIcon';
import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
import MoonIcon from 'phosphor-svelte/lib/MoonIcon';
import PaintBrushIcon from 'phosphor-svelte/lib/PaintBrushIcon';
import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';
import SmileyIcon from 'phosphor-svelte/lib/SmileyIcon';
import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
import TranslateIcon from 'phosphor-svelte/lib/TranslateIcon';
import TreeStructureIcon from 'phosphor-svelte/lib/TreeStructureIcon';
import WheelchairMotionIcon from 'phosphor-svelte/lib/WheelchairMotionIcon';
import { setLanguage } from '#lib/i18n.js';
import { availableLocales, localeLabel, SYSTEM_LANGUAGE } from '#lib/locales.js';
import { SUBSPACE_DEPTHS } from '../definitions';
import type { SettingsCategory } from '../registry';

export const appearanceCategory: SettingsCategory = {
  id: 'appearance',
  name: 'settings.appearanceTitle',
  icon: PaintBrushIcon,
  sections: [
    { id: 'themes', name: 'settings.groups.themes' },
    { id: 'font', name: 'settings.groups.font' },
    { id: 'app-language', name: 'settings.groups.language' },
    { id: 'sidebar', name: 'settings.groups.sidebar' },
    { id: 'unread-badges', name: 'settings.groups.unreadBadges' },
    { id: 'accessibility', name: 'settings.accessibilityTitle' },
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
      key: 'theme',
      section: 'themes',
      icon: MoonIcon,
      name: 'settings.theme',
      terms: ['settings.terms.theme'],
      type: 'select',
      options: [
        { value: 'system', label: 'common.system' },
        { value: 'dark', label: 'common.dark' },
        { value: 'light', label: 'common.light' },
      ],
    },
    {
      key: 'showRoomIcon',
      section: 'sidebar',
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
      key: 'showSpaceEvents',
      section: 'sidebar',
      icon: CalendarBlankIcon,
      name: 'settings.showSpaceEvents',
      type: 'boolean',
    },
    {
      key: 'uniformIcons',
      section: 'sidebar',
      icon: SquaresFourIcon,
      name: 'settings.uniformIcons',
      type: 'boolean',
    },
    {
      key: 'tintRoomIcons',
      section: 'sidebar',
      icon: PaletteIcon,
      name: 'settings.tintRoomIcons',
      description: 'settings.tintRoomIconsHint',
      type: 'boolean',
    },
    {
      key: 'showBridgeBadges',
      section: 'sidebar',
      icon: BridgeIcon,
      name: 'settings.showBridgeBadges',
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
      key: 'showDmTopics',
      section: 'sidebar',
      icon: ChatTextIcon,
      name: 'settings.showDmTopics',
      description: 'settings.showDmTopicsHint',
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
    {
      key: 'pageZoom',
      section: 'accessibility',
      icon: MagnifyingGlassPlusIcon,
      name: 'settings.pageZoom',
      terms: ['settings.terms.pageZoom'],
      type: 'range',
      step: 0.05,
      applyOnCommit: true,
    },
    {
      key: 'textScale',
      section: 'accessibility',
      icon: TextAaIcon,
      name: 'settings.fontScale',
      terms: ['settings.terms.textScale'],
      type: 'range',
      step: 0.05,
      applyOnCommit: true,
    },
    {
      key: 'highContrast',
      section: 'accessibility',
      icon: CircleHalfIcon,
      name: 'settings.highContrast',
      type: 'boolean',
    },
    {
      key: 'underlineLinks',
      section: 'accessibility',
      icon: LinkIcon,
      name: 'settings.underlineLinks',
      type: 'boolean',
    },
    {
      key: 'nameColorCorrection',
      section: 'accessibility',
      icon: PaletteIcon,
      name: 'settings.nameColorCorrection',
      type: 'select',
      options: [
        { value: 'strong', label: 'settings.nameColorCorrectionStrong' },
        { value: 'weak', label: 'settings.nameColorCorrectionWeak' },
        { value: 'off', label: 'settings.nameColorCorrectionOff' },
      ],
    },
    {
      key: 'renderRoomColors',
      section: 'accessibility',
      icon: PaletteIcon,
      name: 'settings.renderRoomColors',
      type: 'boolean',
    },
    {
      key: 'renderProfileColors',
      section: 'accessibility',
      icon: PaletteIcon,
      name: 'settings.renderProfileColors',
      description: 'settings.renderProfileColorsHint',
      type: 'boolean',
    },
    {
      key: 'reducedMotion',
      section: 'accessibility',
      icon: WheelchairMotionIcon,
      name: 'settings.reducedMotion',
      terms: ['settings.terms.reducedMotion'],
      type: 'boolean',
    },
    {
      key: 'alwaysShowAltText',
      section: 'accessibility',
      icon: EyeIcon,
      name: 'settings.alwaysShowAltText',
      terms: ['settings.terms.altText'],
      type: 'boolean',
    },
  ],
};
