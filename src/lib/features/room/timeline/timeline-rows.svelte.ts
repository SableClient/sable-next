import type { TimelineItemView } from '#src/generated/protocol';
import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import type { TimelineEntry } from '#lib/timeline/timeline-window.js';

import { groupTimelineRuns, type TimelineGroupKind } from '../members/member-groups';
import {
  isCollapsed,
  mergeAggregations,
  unreadCountAfter,
  visibleAggregations,
  visibleTimelineItems,
  withDateDividers,
  withReadMarkerBefore,
} from './timeline-format';
import { TimelineIdentityTracker } from './timeline-identity';

export interface RowValue {
  item: TimelineItemView;
  group: readonly TimelineItemView[] | null;
  kind: TimelineGroupKind | null;
  collapsed: boolean;
  groupStart: boolean;
  unreadCount: number;
}

interface RowsDependencies {
  timeline: () => Pick<
    RoomTimeline,
    'items' | 'aggregations' | 'backwardPagination' | 'forwardPagination' | 'mode'
  >;
  readOnly: () => boolean;
  threadRootId: () => string | null;
  readMarkerBefore: () => string | null;
  followingRead: () => boolean;
}

export function holdsEvent({ item, group }: RowValue, eventId: string | null): boolean {
  if (eventId === null) return false;
  return (
    item.event_id === eventId || (group?.some((member) => member.event_id === eventId) ?? false)
  );
}

function sameRow(next: RowValue, previous: RowValue): boolean {
  const sameItem =
    next.item === previous.item ||
    (next.item.event_id === null &&
      next.item.id === previous.item.id &&
      next.item.timestamp === previous.item.timestamp);
  const sameGroup =
    next.group === previous.group ||
    (next.group !== null &&
      previous.group !== null &&
      next.group.length === previous.group.length &&
      next.group.every((member, index) => member === previous.group?.[index]));
  return (
    sameItem &&
    sameGroup &&
    next.collapsed === previous.collapsed &&
    next.groupStart === previous.groupStart &&
    next.unreadCount === previous.unreadCount
  );
}

export class TimelineRows {
  readonly eventItems: TimelineItemView[];
  readonly #allItems: readonly TimelineItemView[];
  readonly visibleItems: readonly TimelineItemView[];
  readonly entries: readonly TimelineEntry<RowValue>[];
  readonly #identity = new TimelineIdentityTracker();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- memo of the last derivation, never a render source
  #previousEntries = new Map<string, TimelineEntry<RowValue>>();

  constructor(deps: RowsDependencies) {
    this.eventItems = $derived(
      visibleTimelineItems(deps.timeline().items, preferences, { readOnly: deps.readOnly() })
    );
    this.#allItems = $derived(
      withDateDividers(
        mergeAggregations(
          this.eventItems,
          visibleAggregations(deps.timeline().aggregations, preferences),
          {
            start: deps.timeline().backwardPagination === 'end',
            end:
              deps.timeline().mode.kind === 'live' || deps.timeline().forwardPagination === 'end',
          }
        )
      )
    );
    this.visibleItems = $derived.by(() => {
      const readMarkerBefore = deps.readMarkerBefore();
      if (readMarkerBefore !== null) return withReadMarkerBefore(this.#allItems, readMarkerBefore);
      return deps.followingRead()
        ? this.#allItems.filter((item) => item.content.kind !== 'read_marker')
        : this.#allItems;
    });
    this.entries = $derived.by((): readonly TimelineEntry<RowValue>[] => {
      const visibleItems = this.visibleItems;
      const threadRootId = deps.threadRootId();
      this.#identity.reconcile(visibleItems);
      const units = groupTimelineRuns(visibleItems);
      const unitItems = units.map((unit) => unit.item);
      const next = units.map(({ item, index: source, group, kind }, index) => {
        const collapsed =
          kind !== 'before_join' &&
          units[index - 1]?.kind !== 'before_join' &&
          !(
            threadRootId &&
            (item.event_id === threadRootId || unitItems[index - 1]?.event_id === threadRootId)
          ) &&
          isCollapsed(unitItems, index, preferences.replyPreviewStyle);
        const entry = {
          key: this.#identity.key(visibleItems, source),
          value: {
            item,
            group,
            kind,
            collapsed,
            groupStart: index > 0 && !collapsed,
            unreadCount:
              item.content.kind === 'read_marker' ? unreadCountAfter(visibleItems, source) : 0,
          },
        };
        const previous = this.#previousEntries.get(entry.key);
        return previous && sameRow(entry.value, previous.value) ? previous : entry;
      });
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- memo of the last derivation, never a render source
      this.#previousEntries = new Map(next.map((entry) => [entry.key, entry]));
      return next;
    });
  }
}
