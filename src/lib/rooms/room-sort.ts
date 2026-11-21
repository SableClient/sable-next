export type RoomSort = 'recent' | 'unread-first' | 'name-asc' | 'name-desc';

export const ROOM_SORTS: readonly RoomSort[] = ['recent', 'unread-first', 'name-asc', 'name-desc'];

export const ROOM_SORT_LABELS: Record<RoomSort, string> = {
  recent: 'nav.sortRecent',
  'unread-first': 'nav.sortUnreadFirst',
  'name-asc': 'common.sortNameAsc',
  'name-desc': 'common.sortNameDesc',
};
