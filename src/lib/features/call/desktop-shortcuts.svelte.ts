import { electronBridge } from '#lib/platform/electron.js';
import { i18n } from '#lib/i18n.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { isDialogOpen, isEditableTarget } from '#lib/ui/shortcuts/binding.js';
import { bindingFor, shortcutCapture } from '#lib/ui/shortcuts/bindings.svelte.js';
import type { DesktopCallShortcut } from '#lib/platform/call-shortcut-types.js';
import type { CallSession } from './call-session.svelte';

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
      else if (event.pressed) void session.toggleMicrophone();
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
        for (const id of ['talk', 'mute'] as const) {
          if (id === 'talk' && session.inputMode !== 'push-to-talk') continue;
          const shortcut = id === 'talk' ? 'call.pushToTalk' : 'call.toggleMute';
          const binding = bindingFor(shortcut);
          if (binding)
            bindings.push({
              id,
              binding,
              description: i18n.t(id === 'talk' ? 'shortcuts.pushToTalk' : 'shortcuts.toggleMute'),
            });
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
