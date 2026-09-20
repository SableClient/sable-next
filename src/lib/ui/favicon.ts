export type FaviconState = 'idle' | 'unread' | 'highlight';

export function faviconState(
  hasUnread: boolean,
  hasHighlight: boolean,
  mentionsOnly: boolean
): FaviconState {
  if (hasHighlight) return 'highlight';
  return hasUnread && !mentionsOnly ? 'unread' : 'idle';
}

export function setFavicon(href: string): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link === null || link.href === href) return;
  link.href = href;
}
