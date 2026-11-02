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

/** Fades the page through when the phone's bottom bar changes tab. Room changes keep the drawer's motion. */
export function tabTransition(navigation: OnNavigate, phone: boolean): Promise<void> | void {
  if (!phone || shouldReduceMotion() || !('startViewTransition' in document)) return;
  const from = tabOf(navigation.from?.url.pathname ?? '');
  const to = tabOf(navigation.to?.url.pathname ?? '');
  if (from === -1 || to === -1 || from === to) return;

  return new Promise((resolve) => {
    document.startViewTransition(async () => {
      resolve();
      await navigation.complete;
    });
  });
}
