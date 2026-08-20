import { page } from '$app/state';

import type { NotificationView } from '#src/generated/NotificationView';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { body, enabled, tag, title } from './present';

export const settingsChanges = $state({ version: 0 });

export class NotificationCenter {
  private stopEvents: (() => void) | null = null;

  start(core: CoreClient): void {
    this.stopEvents?.();
    this.stopEvents = core.subscribeEvents((event) => {
      if (event.type === 'notification_settings_changed') {
        settingsChanges.version += 1;
        return;
      }
      if (event.type === 'notification') this.present(event.notification);
    });
  }

  stop(): void {
    this.stopEvents?.();
    this.stopEvents = null;
  }

  private present(view: NotificationView): void {
    if (!enabled() || reading(view)) return;

    new Notification(title(view), {
      body: body(view),
      tag: tag(view),
      icon: '/favicon.png',
      silent: true,
    });

    if (view.noisy !== false && preferences.notificationSounds) chime();
  }
}

function reading(view: NotificationView): boolean {
  if (document.visibilityState !== 'visible') return false;
  const open = page.params.roomId;
  return open !== undefined && decodeURIComponent(open) === view.room_id;
}

function chime(): void {
  try {
    play();
  } catch (error) {
    console.debug('[sable notifications] no chime', error);
  }
}

function play(): void {
  const context = new AudioContext();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.06, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
  gain.connect(context.destination);

  const tone = context.createOscillator();
  tone.type = 'sine';
  tone.frequency.setValueAtTime(880, context.currentTime);
  tone.frequency.setValueAtTime(1174, context.currentTime + 0.12);
  tone.connect(gain);
  tone.start();
  tone.stop(context.currentTime + 0.36);
  tone.onended = () => void context.close();
}
