export type CallShortcutId = 'talk' | 'mute';

export interface DesktopCallShortcut {
  id: CallShortcutId;
  binding: string;
  description: string;
}

export type DesktopCallShortcutBackend = 'passive' | 'exclusive' | 'portal';

export type DesktopCallShortcutEvent =
  | { id: CallShortcutId; pressed: boolean }
  | { status: 'ready'; backend: DesktopCallShortcutBackend }
  | { status: 'error'; error?: string };
