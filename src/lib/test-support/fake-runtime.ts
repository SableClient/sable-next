import type {
  AppEvent,
  Batch,
  Outcome,
  ReqId,
  RoomListItemView,
  RoomsView,
  Snapshot,
  SubId,
  Subscribed,
  SubscribeRequest,
  Target,
  RpcError,
  Window,
} from '#src/generated/protocol';
import { WIRE_SCHEMA } from '#src/generated/protocol';

import { connect, type Client } from '#lib/runtime/client.js';
import type { Link } from '#lib/runtime/link.js';

/** What the rooms slice serves for a list the server has delivered. Every room shows its counts as they are. */
export function roomsView(
  items: RoomListItemView[],
  status: Partial<Omit<RoomsView, 'total' | 'items'>> = {}
): RoomsView {
  const shown = items.filter(({ counts }: Partial<RoomListItemView>) =>
    counts
      ? counts.unread > 0 || counts.highlight > 0 || counts.marked || counts.notifying > 0
      : false
  );
  return {
    total: items.length,
    items,
    settled: true,
    typing: {},
    quiet_room_ids: [],
    badge_defaults: { direct: 'all', group: 'mentions' },
    badges: Object.fromEntries(shown.map((room) => [room.room_id, { ...room.counts }])),
    space_unread: {},
    ...status,
  };
}

export const replied = (value: unknown = null): Outcome => ({ status: 'ok', value });

export const refused = (error: RpcError): Outcome => ({
  status: 'error',
  error: { kind: 'rpc', error },
});

/** A runtime whose slices hold the state a test gives them. */
export class FakeRuntime implements Link {
  readonly dispatched: { target: Target; action: unknown }[] = [];
  readonly requested: { target: Target; action: unknown }[] = [];
  readonly subscribed: Target[] = [];
  readonly unsubscribed: SubId[] = [];
  /** The window each subscription asked for, then each move of it. */
  readonly windows: (Window | null | undefined)[] = [];
  private readonly states = new Map<string, unknown>();
  private readonly subs = new Map<SubId, { slice: string; rev: number; window?: Window | null }>();
  private listener: (batch: Batch) => void = () => undefined;
  private nextSub = 1;
  private nextReq = 1;
  private tick = 0;

  constructor(
    slices: Record<string, unknown>,
    private readonly answer: (runtime: FakeRuntime, target: Target, action: unknown) => void = () =>
      undefined,
    public reply: (target: Target, action: unknown) => Outcome = () => replied()
  ) {
    for (const [slice, state] of Object.entries(slices)) this.states.set(slice, state);
  }

  client(): Promise<Client> {
    return connect(this);
  }

  /** Replaces what a slice shows, as a patch to the subscribers it has. */
  set(slice: string, state: unknown): void {
    this.states.set(slice, state);
    const events: AppEvent[] = [];
    for (const [sub, held] of this.subs) {
      if (held.slice !== slice) continue;
      held.rev += 1;
      events.push({
        type: 'patch',
        sub,
        rev: held.rev,
        epoch: 0,
        ops: [{ op: 'fields', fields: this.shown(state, held.window) as Record<string, unknown> }],
      });
    }
    this.push(events);
  }

  notice(slice: string, notice: unknown): void {
    this.push([{ type: 'notice', slice, notice, epoch: 0 }]);
  }

  private push(events: AppEvent[]): void {
    if (events.length > 0) this.listener({ tick: ++this.tick, events });
  }

  /** A list slice shows the part of its rows a subscriber follows. */
  private shown(state: unknown, window?: Window | null): unknown {
    const list = state as { items?: unknown[] } | undefined;
    if (!window || !Array.isArray(list?.items)) return state;
    const end = Math.min(window.end, list.items.length);
    return { ...list, items: list.items.slice(Math.min(window.start, end), end) };
  }

  private snapshot(sub: SubId): Snapshot {
    const held = this.subs.get(sub);
    return {
      rev: held?.rev ?? 0,
      epoch: 0,
      state: this.shown(this.states.get(held?.slice ?? ''), held?.window),
    };
  }

  handshake = () =>
    Promise.resolve({
      schema: WIRE_SCHEMA,
      slices: [...this.states.keys()],
    });
  subscribe = (request: SubscribeRequest): Promise<Subscribed> => {
    this.subscribed.push({ slice: request.slice, key: request.key });
    this.windows.push(request.window);
    const sub = this.nextSub++;
    const name = request.slice;
    this.subs.set(sub, { slice: name, rev: 0, window: request.window });
    return Promise.resolve({ sub, snapshot: this.snapshot(sub) });
  };
  unsubscribe = (sub: SubId) => {
    this.unsubscribed.push(sub);
    this.subs.delete(sub);
    return Promise.resolve();
  };
  resync = (sub: SubId) => Promise.resolve(this.snapshot(sub));
  range = (sub: SubId, window: Window | null) => {
    this.windows.push(window);
    const held = this.subs.get(sub);
    if (held) held.window = window;
    return Promise.resolve(this.snapshot(sub));
  };
  dispatch = (target: Target, action: unknown) => {
    this.dispatched.push({ target, action });
    this.answer(this, target, action);
    return Promise.resolve();
  };
  request = (target: Target, action: unknown): Promise<ReqId> => {
    this.requested.push({ target, action });
    const req = this.nextReq++;
    const outcome = this.reply(target, action);
    queueMicrotask(() => {
      this.push([{ type: 'reply', req, epoch: 0, outcome }]);
    });
    return Promise.resolve(req);
  };
  onBatch = (listener: (batch: Batch) => void) => {
    this.listener = listener;
    return () => undefined;
  };
}
