import LockSimpleIcon from 'phosphor-svelte/lib/LockSimpleIcon';
import MoonIcon from 'phosphor-svelte/lib/MoonIcon';
import PaintBrushIcon from 'phosphor-svelte/lib/PaintBrushIcon';
import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';
import { hasDeploymentTheme } from '#lib/deployment/theme.svelte.js';
import type { SettingsCategory } from '../registry';

export const appearanceCategory: SettingsCategory = {
  id: 'appearance',
  name: 'settings.appearanceTitle',
  icon: PaintBrushIcon,
  sections: [
    { id: 'themes', name: 'settings.groups.themes' },
    { id: 'font', name: 'settings.groups.font' },
    { id: 'room-header', name: 'settings.groups.roomHeader' },
  ],
  items: [
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
      key: 'deploymentTheme',
      supported: hasDeploymentTheme,
      section: 'themes',
      icon: PaintBrushIcon,
      name: 'settings.deploymentTheme',
      description: 'settings.deploymentThemeHint',
      type: 'boolean',
    },
    {
      key: 'saturation',
      section: 'themes',
      icon: PaletteIcon,
      name: 'settings.saturation',
      terms: ['settings.terms.saturation'],
      type: 'range',
      step: 0.05,
    },
    {
      key: 'showEncryptionStatusIcon',
      section: 'room-header',
      icon: LockSimpleIcon,
      name: 'settings.showEncryptionStatusIcon',
      type: 'boolean',
    },
  ],
};
