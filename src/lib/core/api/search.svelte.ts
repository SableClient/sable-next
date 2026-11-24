import type { SearchFilter, SearchHitView, SearchOrder, Rpc } from '#src/generated/protocol';

const EMPTY_SEARCH_FILTER: SearchFilter = {
  rooms: [],
  senders: [],
  mentions: [],
  has: [],
  not_rooms: [],
  not_senders: [],
  not_mentions: [],
  not_has: [],
  after_ts: null,
  before_ts: null,
  phrases: [],
  exclude: [],
  pinned: null,
  in_thread: null,
  file_types: [],
  not_file_types: [],
  pattern: null,
  state_events: null,
};

export async function searchMessages(
  rpc: Rpc,
  query: string,
  options: {
    words?: string[];
    filter?: SearchFilter;
    order?: SearchOrder;
    limit?: number;
    offset?: number;
    context?: number;
  } = {}
): Promise<{ hits: SearchHitView[] }> {
  return rpc.search.messages({
    query,
    filter: $state.snapshot(options.filter ?? EMPTY_SEARCH_FILTER),
    order: options.order ?? 'rank',
    limit: options.limit ?? 30,
    offset: options.offset ?? 0,
    context: options.context ?? 0,
    words: options.words ?? [],
  });
}
