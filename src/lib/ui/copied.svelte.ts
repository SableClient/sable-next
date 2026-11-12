import { i18n } from '#lib/i18n.js';
import { copyText } from '#lib/platform/clipboard.js';

import { toasts } from './toasts.svelte.js';

const COPIED_MS = 2000;

export class Copied<T = true> {
  value = $state<T | null>(null);
  #timer: ReturnType<typeof setTimeout> | undefined;

  async copy(text: string, key?: T, { toastOnError = true } = {}): Promise<boolean> {
    try {
      await copyText(text);
    } catch (error) {
      console.debug('[sable] clipboard unavailable', error);
      if (toastOnError) toasts.error(i18n.t('errors.actionFailed'));
      return false;
    }
    this.value = key ?? (true as T);
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.value = null;
    }, COPIED_MS);
    return true;
  }
}
