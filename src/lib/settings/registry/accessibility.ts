import CircleHalfIcon from 'phosphor-svelte/lib/CircleHalfIcon';
import EyeIcon from 'phosphor-svelte/lib/EyeIcon';
import FilmStripIcon from 'phosphor-svelte/lib/FilmStripIcon';
import LinkIcon from 'phosphor-svelte/lib/LinkIcon';
import MagnifyingGlassPlusIcon from 'phosphor-svelte/lib/MagnifyingGlassPlusIcon';
import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';
import PauseIcon from 'phosphor-svelte/lib/PauseIcon';
import StickerIcon from 'phosphor-svelte/lib/StickerIcon';
import TextAaIcon from 'phosphor-svelte/lib/TextAaIcon';
import WheelchairMotionIcon from 'phosphor-svelte/lib/WheelchairMotionIcon';
import type { SettingsCategory } from '../registry';

export const accessibilityCategory: SettingsCategory = {
  id: 'accessibility',
  name: 'settings.accessibilityTitle',
  icon: WheelchairMotionIcon,
  sections: [
    { id: 'accessibility', name: 'settings.groups.display' },
    { id: 'name-colors', name: 'settings.groups.nameColors' },
    { id: 'motion', name: 'settings.groups.motion' },
  ],
  items: [
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
      key: 'alwaysShowAltText',
      section: 'accessibility',
      icon: EyeIcon,
      name: 'settings.alwaysShowAltText',
      terms: ['settings.terms.altText'],
      type: 'boolean',
    },
    {
      key: 'nameColorCorrection',
      section: 'name-colors',
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
      section: 'name-colors',
      icon: PaletteIcon,
      name: 'settings.renderRoomColors',
      type: 'boolean',
    },
    {
      key: 'renderProfileColors',
      section: 'name-colors',
      icon: PaletteIcon,
      name: 'settings.renderProfileColors',
      description: 'settings.renderProfileColorsHint',
      type: 'boolean',
    },
    {
      key: 'reducedMotion',
      section: 'motion',
      icon: WheelchairMotionIcon,
      name: 'settings.reducedMotion',
      terms: ['settings.terms.reducedMotion'],
      type: 'boolean',
    },
    {
      key: 'autoplayGifs',
      section: 'motion',
      icon: FilmStripIcon,
      name: 'settings.autoplayGifs',
      description: 'settings.autoplayGifsHint',
      terms: ['settings.terms.autoplayGifs'],
      type: 'boolean',
    },
    {
      key: 'autoplayStickers',
      section: 'motion',
      icon: StickerIcon,
      name: 'settings.autoplayStickers',
      type: 'boolean',
    },
    {
      key: 'pauseAnimationsWhenInactive',
      section: 'motion',
      icon: PauseIcon,
      name: 'settings.pauseAnimationsWhenInactive',
      type: 'boolean',
    },
  ],
};
