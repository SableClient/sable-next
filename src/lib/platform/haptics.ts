import { invoke } from '@tauri-apps/api/core';

import { isNativeMobile } from './os';

export function hapticFeedback(style: 'light' | 'medium' = 'light'): void {
  const strong = style === 'medium';
  const vibrate = (): void => {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        navigator.vibrate(strong ? 20 : 10);
      }
    } catch {
      return;
    }
  };
  if (isNativeMobile()) {
    void invoke('haptic_feedback', { strong }).catch(vibrate);
  } else {
    vibrate();
  }
}
