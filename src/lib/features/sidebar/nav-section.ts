export type NavSectionKind = 'direct' | 'unspaced' | 'space' | 'home';

export interface NavSectionLabels {
  list: string;
  empty: string;
  title: string;
}

const LABELS: Record<NavSectionKind, NavSectionLabels> = {
  direct: { list: 'nav.chats', empty: 'nav.chatsEmpty', title: 'nav.direct' },
  unspaced: { list: 'nav.rooms', empty: 'nav.unspacedEmpty', title: 'nav.unspaced' },
  space: { list: 'nav.rooms', empty: 'nav.roomsUnavailable', title: 'nav.space' },
  home: { list: 'nav.rooms', empty: 'nav.roomsUnavailable', title: 'nav.home' },
};

export function navSectionKind(pathname: string): NavSectionKind {
  if (pathname.startsWith('/direct')) return 'direct';
  if (pathname.startsWith('/rooms')) return 'unspaced';
  if (pathname.startsWith('/space')) return 'space';

  return 'home';
}

export function navSectionLabels(kind: NavSectionKind): NavSectionLabels {
  return LABELS[kind];
}
