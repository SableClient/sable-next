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
  | 'room.editOlder'
  | 'room.editNewer'
  | 'call.toggleMute'
  | 'call.toggleDeafen'
  | 'call.toggleCamera'
  | 'call.toggleScreenShare'
  | 'call.hangUp'
  | 'composer.strong'
  | 'composer.em'
  | 'composer.underline'
  | 'composer.strike'
  | 'composer.code'
  | 'composer.sub'
  | 'composer.sup'
  | 'composer.spoiler'
  | 'composer.bullet_list'
  | 'composer.ordered_list'
  | 'composer.blockquote'
  | 'composer.heading1'
  | 'composer.heading2'
  | 'composer.heading3'
  | 'composer.code_block'
  | 'composer.link'
  | 'composer.toggleSource';

export interface ShortcutDefinition {
  id: ShortcutId;
  labelKey: string;
  category: 'general' | 'navigation' | 'room' | 'call' | 'composer';
  binding: string;
  allowInEditable?: boolean;
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'navigation.openRoomSearch',
    labelKey: 'shortcuts.paletteTitle',
    category: 'navigation',
    binding: 'mod+k',
    allowInEditable: true,
  },
  {
    id: 'app.searchMessages',
    labelKey: 'common.searchMessages',
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
    labelKey: 'common.createARoom',
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
    id: 'room.editOlder',
    labelKey: 'shortcuts.editOlder',
    category: 'room',
    binding: 'ctrl+shift+up',
  },
  {
    id: 'room.editNewer',
    labelKey: 'shortcuts.editNewer',
    category: 'room',
    binding: 'ctrl+shift+down',
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
  {
    id: 'composer.strong',
    labelKey: 'composer.bold',
    category: 'composer',
    binding: 'mod+b',
    allowInEditable: true,
  },
  {
    id: 'composer.em',
    labelKey: 'composer.italic',
    category: 'composer',
    binding: 'mod+i',
    allowInEditable: true,
  },
  {
    id: 'composer.underline',
    labelKey: 'composer.underline',
    category: 'composer',
    binding: 'mod+u',
    allowInEditable: true,
  },
  {
    id: 'composer.strike',
    labelKey: 'composer.strike',
    category: 'composer',
    binding: 'mod+shift+x',
    allowInEditable: true,
  },
  {
    id: 'composer.code',
    labelKey: 'composer.code',
    category: 'composer',
    binding: 'mod+e',
    allowInEditable: true,
  },
  {
    id: 'composer.sub',
    labelKey: 'composer.subscript',
    category: 'composer',
    binding: 'mod+,',
    allowInEditable: true,
  },
  {
    id: 'composer.sup',
    labelKey: 'composer.superscript',
    category: 'composer',
    binding: 'mod+.',
    allowInEditable: true,
  },
  {
    id: 'composer.spoiler',
    labelKey: 'composer.spoiler',
    category: 'composer',
    binding: 'mod+h',
    allowInEditable: true,
  },
  {
    id: 'composer.bullet_list',
    labelKey: 'composer.bulletList',
    category: 'composer',
    binding: 'mod+shift+8',
    allowInEditable: true,
  },
  {
    id: 'composer.ordered_list',
    labelKey: 'composer.orderedList',
    category: 'composer',
    binding: 'mod+shift+9',
    allowInEditable: true,
  },
  {
    id: 'composer.blockquote',
    labelKey: 'composer.quote',
    category: 'composer',
    binding: 'mod+shift+.',
    allowInEditable: true,
  },
  {
    id: 'composer.heading1',
    labelKey: 'composer.heading1',
    category: 'composer',
    binding: 'mod+1',
    allowInEditable: true,
  },
  {
    id: 'composer.heading2',
    labelKey: 'composer.heading2',
    category: 'composer',
    binding: 'mod+2',
    allowInEditable: true,
  },
  {
    id: 'composer.heading3',
    labelKey: 'composer.heading3',
    category: 'composer',
    binding: 'mod+3',
    allowInEditable: true,
  },
  {
    id: 'composer.code_block',
    labelKey: 'composer.codeBlock',
    category: 'composer',
    binding: 'mod+;',
    allowInEditable: true,
  },
  {
    id: 'composer.link',
    labelKey: 'composer.link',
    category: 'composer',
    binding: 'mod+shift+k',
    allowInEditable: true,
  },
  {
    id: 'composer.toggleSource',
    labelKey: 'composer.markdownSource',
    category: 'composer',
    binding: 'mod+shift+m',
    allowInEditable: true,
  },
] as const;

export function shortcutScope(shortcut: Pick<ShortcutDefinition, 'category'>): string {
  return shortcut.category === 'composer' ? 'composer' : 'global';
}

export function shortcutsConflicts(isMac: boolean): ReturnType<typeof findShortcutConflicts> {
  return findShortcutConflicts(
    SHORTCUTS.map((shortcut) => ({
      id: shortcut.id,
      binding: shortcut.binding,
      scope: shortcutScope(shortcut),
    })),
    isMac
  );
}
