import type { TimelineItemView, TimelineRowView } from '#src/generated/protocol';
import type { ResolvedItem, ResolvedRow } from '#lib/rooms/timeline-item.js';

/** Rows built by hand, as the runtime would send them, for a test or a stand-in runtime. */
export function asWireRows(rows: readonly ResolvedRow[]): TimelineRowView[] {
  return rows as unknown as TimelineRowView[];
}

export function asWireItems(items: readonly ResolvedItem[]): TimelineItemView[] {
  return items as unknown as TimelineItemView[];
}
