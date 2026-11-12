import { electronBridge } from '#lib/platform/electron.js';
import { i18n } from '#lib/i18n.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { isDialogOpen, isEditableTarget } from '#lib/ui/shortcuts/binding.js';
import { bindingFor, shortcutCapture } from '#lib/ui/shortcuts/bindings.svelte.js';
import type { CallShortcutId, DesktopCallShortcut } from '#lib/platform/call-shortcut-types.js';
import type { ShortcutId } from '#lib/ui/shortcuts/shortcuts.js';
import type { CallSession } from './call-session.svelte';

const GLOBAL_SHORTCUTS: Record<CallShortcutId, { shortcut: ShortcutId; label: string }> = {
  talk: { shortcut: 'call.pushToTalk', label: 'shortcuts.pushToTalk' },
  mute: { shortcut: 'call.toggleMute', label: 'shortcuts.toggleMute' },
  deafen: { shortcut: 'call.toggleDeafen', label: 'shortcuts.toggleDeafen' },
};

export function registerDesktopCallShortcuts(session: CallSession): () => void {
  const bridge = electronBridge();
  if (!bridge) return () => {};

  return $effect.root(() => {
    const isEditing = (): boolean =>
      document.hasFocus() && (isEditableTarget(document.activeElement) || isDialogOpen());
    let enabled = false;
    const offNative = bridge.onCallShortcut((event) => {
      if ('status' in event) {
        if (enabled)
          session.desktopShortcutStatus = event.status === 'ready' ? event.backend : 'error';
        return;
      }
      if (event.pressed && (!enabled || shortcutCapture.active || isEditing())) return;
      if (event.id === 'talk') void session.setTalking(event.pressed, 'desktop');
      else if (event.pressed && event.id === 'mute') void session.toggleMicrophone();
      else if (event.pressed) session.setDeafened(!session.deafened);
    });

    $effect(() => {
      enabled =
        session.lifecycle === 'active' &&
        session.mediaReady &&
        !session.listenOnly &&
        preferences.callGlobalShortcuts &&
        !shortcutCapture.active;
      const bindings: DesktopCallShortcut[] = [];
      if (enabled) {
        for (const id of ['talk', 'mute', 'deafen'] as const) {
          if (id === 'talk' && session.inputMode !== 'push-to-talk') continue;
          const { shortcut, label } = GLOBAL_SHORTCUTS[id];
          const binding = bindingFor(shortcut);
          if (binding) bindings.push({ id, binding, description: i18n.t(label) });
        }
      }
      session.desktopShortcutStatus = 'inactive';
      void bridge.setCallShortcuts(bindings).catch(() => {
        session.desktopShortcutStatus = 'error';
      });
      return () => {
        void session.setTalking(false, 'desktop');
        void bridge.setCallShortcuts([]).catch(() => {});
      };
    });

    return offNative;
  });
}
