import type { Rpc, RpcParams } from '#src/generated/protocol';

type CreateParams = RpcParams<Rpc['rooms']['create']>;
export type CreateRoomOptions = Partial<Omit<CreateParams, 'room_id'>>;

export function createRoom(rpc: Pick<Rpc, 'rooms'>, options: CreateRoomOptions): Promise<string> {
  return rpc.rooms.create({
    name: options.name ?? null,
    topic: options.topic ?? null,
    kind: options.kind ?? 'text',
    public: options.public ?? false,
    encrypted: options.encrypted ?? true,
    invite: [...(options.invite ?? [])],
    parent_space: options.parent_space ?? null,
    alias: options.alias ?? null,
    room_version: options.room_version ?? null,
    join_rule: options.join_rule ?? null,
    federate: options.federate ?? true,
    predecessor: options.predecessor ?? null,
  });
}

/** Copies `via`, so a reactive proxy cannot reach the transport. */
export function joinRoom(
  rpc: Pick<Rpc, 'rooms'>,
  address: string,
  via: readonly string[] = []
): Promise<string> {
  return rpc.rooms.join({ address, via: [...via] });
}

export function knockRoom(
  rpc: Pick<Rpc, 'rooms'>,
  address: string,
  via: readonly string[] = [],
  reason?: string
): Promise<string> {
  return rpc.rooms.knock({
    address,
    via: [...via],
    reason: reason ?? null,
  });
}
