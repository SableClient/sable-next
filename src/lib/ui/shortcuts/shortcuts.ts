import { findShortcutConflicts } from './binding.js';

export type ShortcutId =
  | 'app.searchMessages'
  | 'app.openBookmarks'
  | 'app.createRoom'
  | 'app.showShortcuts'
  | 'navigation.openRoomSearch'
  | 'navigation.nextUnread'
  | 'navigation.cycleNextUnread'
  | 'navigation.cyclePreviousUnread';

export interface ShortcutDefinition {
  id: ShortcutId;
  labelKey: string;
  category: 'general' | 'navigation';
  binding: string;
  allowInEditable?: boolean;
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'navigation.openRoomSearch',
    labelKey: 'shortcuts.openRoomSearch',
    category: 'navigation',
    binding: 'mod+k',
    allowInEditable: true,
  },
  {
    id: 'app.searchMessages',
    labelKey: 'shortcuts.searchMessages',
    category: 'general',
    binding: 'mod+f',
    allowInEditable: true,
  },
  {
    id: 'app.openBookmarks',
    labelKey: 'shortcuts.openBookmarks',
    category: 'general',
    binding: 'mod+shift+b',
  },
  {
    id: 'app.createRoom',
    labelKey: 'shortcuts.createRoom',
    category: 'general',
    binding: 'mod+shift+n',
  },
  {
    id: 'app.showShortcuts',
    labelKey: 'shortcuts.showShortcuts',
    category: 'general',
    binding: 'mod+/',
  },
  {
    id: 'navigation.nextUnread',
    labelKey: 'shortcuts.nextUnread',
    category: 'navigation',
    binding: 'alt+n',
  },
  {
    id: 'navigation.cycleNextUnread',
    labelKey: 'shortcuts.cycleNextUnread',
    category: 'navigation',
    binding: 'alt+shift+down',
  },
  {
    id: 'navigation.cyclePreviousUnread',
    labelKey: 'shortcuts.cyclePreviousUnread',
    category: 'navigation',
    binding: 'alt+shift+up',
  },
] as const;

const GLOBAL_SCOPE = 'global';

export function shortcutsConflicts(isMac: boolean): ReturnType<typeof findShortcutConflicts> {
  return findShortcutConflicts(
    SHORTCUTS.map((shortcut) => ({
      id: shortcut.id,
      binding: shortcut.binding,
      scope: GLOBAL_SCOPE,
    })),
    isMac
  );
}
