import type { OnNavigate } from '$app/navigation';

import { shouldReduceMotion } from './motion.js';

const TABS: readonly (readonly string[])[] = [
  ['/rooms', '/direct', '/space/', '/home'],
  ['/navigate'],
  ['/inbox', '/bookmarks'],
  ['/profile'],
];

function tabOf(pathname: string): number {
  return TABS.findIndex((prefixes) => prefixes.some((prefix) => pathname.startsWith(prefix)));
}

/**
 * Slides the page between the phone's bottom tabs, toward the tab that was picked. Room changes keep
 * the drawer's own motion, so only a change of tab animates here.
 */
export function tabTransition(navigation: OnNavigate, phone: boolean): Promise<void> | void {
  if (!phone || shouldReduceMotion() || !('startViewTransition' in document)) return;
  const from = tabOf(navigation.from?.url.pathname ?? '');
  const to = tabOf(navigation.to?.url.pathname ?? '');
  if (from === -1 || to === -1 || from === to) return;

  document.documentElement.dataset.tabDirection = to > from ? 'forward' : 'back';
  return new Promise((resolve) => {
    const transition = document.startViewTransition(async () => {
      resolve();
      await navigation.complete;
    });
    void transition.finished.finally(() => {
      delete document.documentElement.dataset.tabDirection;
    });
  });
}
