import type { CoreEvent } from '#src/generated/CoreEvent';
import type { SubscriptionId } from '#src/generated/SubscriptionId';

type TimelineEvent = Extract<CoreEvent, { type: 'timeline_diff' | 'timeline_pagination' }>;
const MAX_PENDING_EVENTS = 100;

export class TimelineEventRouter<Owner> {
  private readonly owners = new Map<SubscriptionId, Owner>();
  private readonly pending = new Map<SubscriptionId, TimelineEvent[]>();
  private readonly pendingOwners = new Map<Owner, number>();
  private pendingEventCount = 0;

  begin(owner: Owner): void {
    this.pendingOwners.set(owner, (this.pendingOwners.get(owner) ?? 0) + 1);
  }

  cancelPending(owner: Owner): void {
    const pending = this.pendingOwners.get(owner);
    if (pending === undefined) return;
    if (pending === 1) this.pendingOwners.delete(owner);
    else this.pendingOwners.set(owner, pending - 1);
    this.clearOrphanedEvents();
  }

  route(event: TimelineEvent): Owner | null {
    const owner = this.owners.get(event.subscription);
    if (owner) return owner;

    if (this.pendingOwners.size === 0) return null;

    const pending = this.pending.get(event.subscription) ?? [];
    while (this.pendingEventCount >= MAX_PENDING_EVENTS) this.dropOldestPendingEvent();
    pending.push(event);
    this.pendingEventCount += 1;
    this.pending.set(event.subscription, pending);
    return null;
  }

  claim(subscription: SubscriptionId, owner: Owner): TimelineEvent[] | null {
    if (!this.pendingOwners.has(owner)) return null;
    const pending = this.pending.get(subscription) ?? [];
    this.pending.delete(subscription);
    this.pendingEventCount -= pending.length;
    this.cancelPending(owner);
    this.owners.set(subscription, owner);
    return pending;
  }

  release(subscription: SubscriptionId): void {
    this.owners.delete(subscription);
    const pending = this.pending.get(subscription);
    if (pending) this.pendingEventCount -= pending.length;
    this.pending.delete(subscription);
  }

  owns(subscription: SubscriptionId, owner: Owner): boolean {
    return this.owners.get(subscription) === owner;
  }

  removeOwner(owner: Owner): SubscriptionId[] {
    this.pendingOwners.delete(owner);
    this.clearOrphanedEvents();
    const subscriptions: SubscriptionId[] = [];
    for (const [subscription, current] of this.owners) {
      if (current === owner) {
        subscriptions.push(subscription);
        this.release(subscription);
      }
    }
    return subscriptions;
  }

  private clearOrphanedEvents(): void {
    if (this.pendingOwners.size === 0) {
      this.pending.clear();
      this.pendingEventCount = 0;
    }
  }

  private dropOldestPendingEvent(): void {
    const [subscription, events] = this.pending.entries().next().value as [
      SubscriptionId,
      TimelineEvent[],
    ];
    events.shift();
    this.pendingEventCount -= 1;
    if (events.length === 0) this.pending.delete(subscription);
  }
}
