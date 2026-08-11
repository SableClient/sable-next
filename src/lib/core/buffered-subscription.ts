import type { SubscriptionId } from '@/generated/SubscriptionId';

interface SubscriptionDiff<Diff> {
  subscription: SubscriptionId;
  diffs: readonly Diff[];
}

export function bufferSubscription<Event, Diff, Item>(
  subscribeEvents: (listener: (event: Event) => void) => () => void,
  select: (event: Event) => SubscriptionDiff<Diff> | null,
  apply: (items: readonly Item[], diffs: readonly Diff[]) => Item[],
  update: (diffs: readonly Diff[]) => void
) {
  let subscription: SubscriptionId | null = null;
  const buffered = new Map<SubscriptionId, Diff[]>();
  const stop = subscribeEvents((event) => {
    const selected = select(event);
    if (!selected) return;

    if (subscription === null) {
      const diffs = buffered.get(selected.subscription) ?? [];
      buffered.set(selected.subscription, [...diffs, ...selected.diffs]);
    } else if (selected.subscription === subscription) {
      update(selected.diffs);
    }
  });

  return {
    activate(nextSubscription: SubscriptionId, items: readonly Item[]): Item[] {
      subscription = nextSubscription;
      const diffs = buffered.get(nextSubscription) ?? [];
      buffered.clear();
      return apply(items, diffs);
    },
    stop,
  };
}
