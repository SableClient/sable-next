import { findShortcutConflicts } from './binding.js';

export type ShortcutId =
  | 'app.searchMessages'
  | 'app.openBookmarks'
  | 'app.createRoom'
  | 'app.showShortcuts'
  | 'app.openSettings'
  | 'navigation.openRoomSearch'
  | 'navigation.previousRoom'
  | 'navigation.nextRoom'
  | 'navigation.nextUnread'
  | 'navigation.cycleNextUnread'
  | 'navigation.cyclePreviousUnread'
  | 'room.markRead'
  | 'room.markAllRead'
  | 'room.replyOlder'
  | 'room.replyNewer'
  | 'call.toggleMute'
  | 'call.toggleDeafen'
  | 'call.toggleCamera'
  | 'call.toggleScreenShare'
  | 'call.hangUp';

export interface ShortcutDefinition {
  id: ShortcutId;
  labelKey: string;
  category: 'general' | 'navigation' | 'room' | 'call';
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
    id: 'app.openSettings',
    labelKey: 'shortcuts.openSettings',
    category: 'general',
    binding: 'mod+,',
  },
  {
    id: 'navigation.previousRoom',
    labelKey: 'shortcuts.previousRoom',
    category: 'navigation',
    binding: 'alt+up',
    allowInEditable: true,
  },
  {
    id: 'navigation.nextRoom',
    labelKey: 'shortcuts.nextRoom',
    category: 'navigation',
    binding: 'alt+down',
    allowInEditable: true,
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
  {
    id: 'room.markRead',
    labelKey: 'shortcuts.markRead',
    category: 'room',
    binding: 'shift+escape',
  },
  {
    id: 'room.markAllRead',
    labelKey: 'shortcuts.markAllRead',
    category: 'room',
    binding: 'mod+shift+escape',
  },
  {
    id: 'room.replyOlder',
    labelKey: 'shortcuts.replyOlder',
    category: 'room',
    binding: 'ctrl+up',
  },
  {
    id: 'room.replyNewer',
    labelKey: 'shortcuts.replyNewer',
    category: 'room',
    binding: 'ctrl+down',
  },
  {
    id: 'call.toggleMute',
    labelKey: 'shortcuts.toggleMute',
    category: 'call',
    binding: 'mod+shift+m',
    allowInEditable: true,
  },
  {
    id: 'call.toggleDeafen',
    labelKey: 'shortcuts.toggleDeafen',
    category: 'call',
    binding: 'mod+shift+d',
    allowInEditable: true,
  },
  {
    id: 'call.toggleCamera',
    labelKey: 'shortcuts.toggleCamera',
    category: 'call',
    binding: 'mod+shift+v',
  },
  {
    id: 'call.toggleScreenShare',
    labelKey: 'shortcuts.toggleScreenShare',
    category: 'call',
    binding: 'mod+shift+e',
  },
  {
    id: 'call.hangUp',
    labelKey: 'shortcuts.hangUp',
    category: 'call',
    binding: 'mod+shift+h',
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
