import { createSubscriber, MediaQuery } from 'svelte/reactivity';
import { on } from 'svelte/events';

declare global {
  interface Window {
    __sableAndroidSystemTheme?: { isDarkMode(): boolean };
  }
}

const media = new MediaQuery('(prefers-color-scheme: dark)');
const subscribe = createSubscriber((update) => on(window, 'sable:system-theme-changed', update));

export const systemDark = {
  get current(): boolean {
    // WebView's media query follows the app theme; use Android's night mode instead.
    const android = window.__sableAndroidSystemTheme;
    if (android) {
      subscribe();
      return android.isDarkMode();
    }
    return media.current;
  },
};
