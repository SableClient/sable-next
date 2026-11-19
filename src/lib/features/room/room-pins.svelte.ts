import { createContext } from 'svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';

import type { PinReadStateView, Rpc, TimelineItemView } from '#src/generated/protocol';

import type { EventItems } from './messages/event-items.svelte.js';

type RoomPinCommands = Pick<
  Rpc['timeline'],
  'pinReadState' | 'pinnedEvents' | 'eventItems' | 'markPinsSeen' | 'setPinned'
>;

export class RoomPins {
  pinnedIds = $state.raw<readonly string[]>([]);
  unread = $state(0);
  fresh = $state.raw<ReadonlySet<string>>(new SvelteSet());
  loading = $state(false);
  entries = $state.raw<ReadonlyMap<string, TimelineItemView>>(new SvelteMap());
  settled = $state.raw<ReadonlySet<string>>(new SvelteSet());
  #shownIds = $state.raw<readonly string[]>([]);
  ordered = $derived([...this.#shownIds].reverse());

  #pending: ReadonlySet<string> = new SvelteSet();
  #roomId: string | null = null;
  #countRun = 0;
  #loadRun = 0;

  constructor(
    private readonly commands: RoomPinCommands,
    private readonly eventItems: Pick<EventItems, 'peek' | 'put'>
  ) {}

  async refresh(roomId: string): Promise<void> {
    const current = ++this.#countRun;
    try {
      const state = await this.commands.pinReadState({ room_id: roomId });
      if (current !== this.#countRun) return;
      this.#adopt(state);
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    }
  }

  async load(roomId: string): Promise<void> {
    const current = ++this.#loadRun;
    if (roomId !== this.#roomId) {
      this.#roomId = roomId;
      this.#shownIds = [];
      this.entries = new SvelteMap();
      this.#pending = new SvelteSet();
      this.settled = new SvelteSet();
    }
    this.loading = true;
    try {
      const ids = await this.commands.pinnedEvents({ room_id: roomId });
      if (current !== this.#loadRun) return;
      this.pinnedIds = ids;
      this.#shownIds = ids;
      this.entries = new SvelteMap(
        ids.flatMap((id) => {
          const item = this.entries.get(id) ?? this.eventItems.peek(roomId, id);
          return item ? [[id, item] as const] : [];
        })
      );
      this.#pending = new SvelteSet();
      this.settled = new SvelteSet(this.entries.keys());
      await this.#markSeen(roomId, ids, current);
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    } finally {
      if (current === this.#loadRun) this.loading = false;
    }
  }

  resolveRange(start: number, stop: number): void {
    const roomId = this.#roomId;
    if (!roomId) return;
    const missing = this.ordered
      .slice(Math.max(0, start), stop + 1)
      .filter((id) => !this.settled.has(id) && !this.#pending.has(id));
    if (missing.length === 0) return;
    this.#pending = new SvelteSet([...this.#pending, ...missing]);
    void this.#resolve(roomId, missing, this.#loadRun);
  }

  async unpin(roomId: string, eventId: string): Promise<void> {
    this.pinnedIds = await this.commands.setPinned({
      room_id: roomId,
      event_id: eventId,
      pinned: false,
    });
    this.#shownIds = this.#shownIds.filter((id) => id !== eventId);
  }

  async #resolve(roomId: string, ids: string[], current: number): Promise<void> {
    try {
      const items = await this.commands.eventItems({ room_id: roomId, event_ids: ids });
      if (current !== this.#loadRun) return;
      if (items.length > 0) {
        this.entries = new SvelteMap([
          ...this.entries,
          ...items.flatMap((item) => (item.event_id ? [[item.event_id, item] as const] : [])),
        ]);
        this.eventItems.put(roomId, items);
      }
    } catch (error) {
      console.debug('[sable room] pins unavailable', error);
    } finally {
      if (current === this.#loadRun) {
        const done = new SvelteSet(ids);
        this.#pending = new SvelteSet([...this.#pending].filter((id) => !done.has(id)));
        this.settled = new SvelteSet([...this.settled, ...ids]);
      }
    }
  }

  #adopt(state: PinReadStateView): void {
    this.pinnedIds = state.pinned_ids;
    this.unread = state.unread;
    this.fresh = new SvelteSet(state.fresh_ids);
  }

  async #markSeen(roomId: string, ids: readonly string[], current: number): Promise<void> {
    if (ids.length === 0) return;
    this.unread = 0;
    try {
      const state = await this.commands.markPinsSeen({ room_id: roomId, pinned_ids: [...ids] });
      if (current !== this.#loadRun) return;
      this.#adopt(state);
    } catch (error) {
      console.debug('[sable room] pin marker not stored', error);
    }
  }
}

export const [useRoomPins, provideRoomPins] = createContext<RoomPins>();
