import DesktopIcon from 'phosphor-svelte/lib/DesktopIcon';
import FilmStripIcon from 'phosphor-svelte/lib/FilmStripIcon';
import GraphicsCardIcon from 'phosphor-svelte/lib/GraphicsCardIcon';
import MouseIcon from 'phosphor-svelte/lib/MouseIcon';
import { electronBridge, isElectron } from '#lib/platform/electron.js';
import {
  supportsCustomTitleBar,
  supportsSmoothScrollingToggle,
  supportsTray,
} from '#lib/platform/window-decorations.js';
import type { SettingsCategory } from '../registry';

export const desktopCategories: SettingsCategory[] = isElectron()
  ? [
      {
        id: 'desktop',
        name: 'settings.desktopTitle',
        icon: DesktopIcon,
        sections: [
          { id: 'window', name: 'settings.groups.window' },
          { id: 'performance', name: 'settings.groups.performance' },
        ],
        items: [
          {
            key: 'useCustomTitleBar',
            section: 'window',
            icon: DesktopIcon,
            name: 'settings.useCustomTitleBar',
            type: 'boolean',
            supported: supportsCustomTitleBar,
          },
          {
            key: 'showSystemTrayIcon',
            section: 'window',
            icon: DesktopIcon,
            name: 'settings.showSystemTrayIcon',
            type: 'boolean',
            supported: supportsTray,
          },
          {
            key: 'closeToTray',
            section: 'window',
            icon: DesktopIcon,
            name: 'settings.closeToTray',
            description: 'settings.closeToTrayHint',
            type: 'boolean',
            gatedBy: 'showSystemTrayIcon',
            supported: supportsTray,
          },
          {
            key: 'minimizeToTray',
            section: 'window',
            icon: DesktopIcon,
            name: 'settings.minimizeToTray',
            description: 'settings.minimizeToTrayHint',
            type: 'boolean',
            gatedBy: 'showSystemTrayIcon',
            supported: supportsTray,
          },
          {
            key: 'launchAtLogin',
            section: 'window',
            icon: DesktopIcon,
            name: 'settings.launchAtLogin',
            type: 'boolean',
            supported: () => electronBridge()?.autostartAvailable === true,
          },
          {
            key: 'startMinimized',
            section: 'window',
            icon: DesktopIcon,
            name: 'settings.startMinimized',
            description: 'settings.startMinimizedHint',
            type: 'boolean',
          },
          {
            key: 'hardwareAcceleration',
            section: 'performance',
            icon: GraphicsCardIcon,
            name: 'settings.hardwareAcceleration',
            description: 'settings.hardwareAccelerationHint',
            type: 'boolean',
            supported: isElectron,
          },
          {
            key: 'hardwareVideoAcceleration',
            section: 'performance',
            icon: FilmStripIcon,
            name: 'settings.hardwareVideoAcceleration',
            description: 'settings.hardwareVideoAccelerationHint',
            type: 'boolean',
            gatedBy: 'hardwareAcceleration',
            supported: isElectron,
          },
          {
            key: 'smoothScrolling',
            section: 'performance',
            icon: MouseIcon,
            name: 'settings.smoothScrolling',
            description: 'settings.smoothScrollingHint',
            type: 'boolean',
            supported: supportsSmoothScrollingToggle,
          },
        ],
      },
    ]
  : [];
