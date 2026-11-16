import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';

import type { Rpc, RoomRulesView } from '#src/generated/protocol';

export const ROOM_RULES_EVENT_TYPE = 'computer.gingershaped.msc4534.rules';

type RulesRpc = { room_state: Pick<Rpc['room_state'], 'rules' | 'acceptRules'> };

/** Dismissed prompts by the room the rules come from, kept until the app restarts. */
const dismissed = new SvelteMap<string, number>();

function sameRules(left: RoomRulesView, right: RoomRulesView): boolean {
  return (
    left.source_room_id === right.source_room_id &&
    left.version === right.version &&
    left.html === right.html
  );
}

export class RoomRules {
  view = $state.raw<RoomRulesView | null>(null);
  /**
   * The rules on screen. They stay as read while the dialog is up, so that
   * accepting never covers text that arrived under the reader.
   */
  shown = $state.raw<RoomRulesView | null>(null);
  open = $state(false);
  accepting = $state(false);
  #roomId: string | null = null;
  #generation = 0;
  #failed = false;
  #accepted: { roomId: string; version: number } | null = null;

  constructor(private readonly rpc: RulesRpc) {}

  get blocking(): boolean {
    return this.view !== null && this.view.require_acceptance && !this.view.accepted;
  }

  get prompting(): boolean {
    const view = this.view;
    return this.blocking && view !== null && dismissed.get(view.source_room_id) !== view.version;
  }

  get visible(): boolean {
    return this.shown !== null && (this.open || this.prompting);
  }

  get stale(): boolean {
    return this.shown !== null && this.view !== null && this.shown !== this.view;
  }

  get removed(): boolean {
    return this.shown !== null && this.view === null;
  }

  review(): void {
    this.shown = this.view;
  }

  dismiss(): void {
    this.open = false;
    if (this.view) dismissed.set(this.view.source_room_id, this.view.version);
    this.shown = this.view;
  }

  async load(roomId: string): Promise<void> {
    const generation = ++this.#generation;
    if (this.#roomId !== roomId) {
      this.#roomId = roomId;
      this.view = null;
      this.shown = null;
      this.open = false;
    }
    try {
      const view = await this.rpc.room_state.rules({ room_id: roomId });
      if (generation !== this.#generation) return;
      this.#failed = false;
      this.#apply(view);
    } catch (error) {
      if (generation === this.#generation) this.#failed = true;
      console.debug('[sable room] rules unavailable', error);
    }
  }

  retry(): void {
    if (this.#failed && this.#roomId !== null) void this.load(this.#roomId);
  }

  async accept(): Promise<void> {
    const view = this.shown;
    if (view === null || this.stale || this.removed || this.accepting) return;
    this.accepting = true;
    try {
      await this.rpc.room_state.acceptRules({
        room_id: view.source_room_id,
        version: view.version,
      });
      this.#accepted = { roomId: view.source_room_id, version: view.version };
      this.open = false;
      if (this.view !== null) this.#apply(this.view);
    } finally {
      this.accepting = false;
    }
  }

  #apply(next: RoomRulesView | null): void {
    // The account data echo lags the write, so a reload in between would lock the room again.
    const accepted = this.#accepted;
    const view =
      next !== null &&
      !next.accepted &&
      accepted?.roomId === next.source_room_id &&
      accepted.version >= next.version
        ? { ...next, accepted: true }
        : next;
    const keep =
      this.visible && this.shown !== null && (view === null || !sameRules(this.shown, view));
    // A prompt would close with the rules it was asking about, without a word.
    if (keep && view === null) this.open = true;
    this.view = view;
    if (!keep) this.shown = view;
  }
}

export const [useRoomRulesOpener, provideRoomRulesOpener, hasRoomRulesOpener] =
  createContext<() => void>();
