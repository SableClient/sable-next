import type { DirectoryRoomType, PublicRoomView } from '#src/generated/protocol';

import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { CoreError } from '#src/transport';

export type RoomDirectoryApi = Pick<CoreCommands, 'publicRooms'>;

export type DirectoryQuery = {
  server: string | null;
  search: string;
  roomType?: DirectoryRoomType | null;
};

export const EMPTY_QUERY: DirectoryQuery = { server: null, search: '' };

export class RoomDirectory {
  rooms = $state.raw<PublicRoomView[]>([]);
  total = $state<number | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);

  #query: DirectoryQuery = EMPTY_QUERY;
  #nextBatch: string | null = null;
  #generation = 0;

  constructor(private readonly commands: RoomDirectoryApi) {}

  get query(): DirectoryQuery {
    return this.#query;
  }

  get hasMore(): boolean {
    return this.#nextBatch !== null;
  }

  async search(query: DirectoryQuery): Promise<void> {
    const generation = ++this.#generation;
    this.#query = query;
    this.#nextBatch = null;
    this.rooms = [];
    this.total = null;

    await this.#fetch(generation, null);
  }

  async loadMore(): Promise<void> {
    const since = this.#nextBatch;
    if (since === null || this.loading) return;

    await this.#fetch(++this.#generation, since);
  }

  async #fetch(generation: number, since: string | null): Promise<void> {
    this.loading = true;
    this.error = null;

    try {
      const roomType = this.#query.roomType ?? null;
      const page = await this.commands.publicRooms({
        server: this.#query.server,
        search: this.#query.search,
        since,
        ...(roomType ? { roomType } : {}),
      });
      if (generation !== this.#generation) return;

      const rooms = roomType
        ? page.rooms.filter((room) => room.is_space === (roomType === 'spaces'))
        : page.rooms;
      this.rooms = since === null ? rooms : mergeRooms(this.rooms, rooms);
      this.total = page.total;
      this.#nextBatch = page.next_batch;
    } catch (cause) {
      if (generation !== this.#generation) return;
      console.warn('[sable directory] the room directory is unavailable', cause);
      this.error = directoryErrorMessage(cause);
      this.#nextBatch = null;
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }
}

function directoryErrorMessage(cause: unknown): string {
  if (cause instanceof CoreError) {
    switch (cause.detail.code) {
      case 'unknown_homeserver':
        return 'room.directoryInvalidServer';
      case 'denied':
        return 'room.directoryPrivate';
      case 'unsupported':
        return 'room.directoryUnsupported';
      case 'unavailable':
        return 'room.directoryUnavailable';
      case 'rate_limited':
        return 'room.directoryRateLimited';
    }
  }

  return 'room.directoryFailed';
}

function mergeRooms(
  current: readonly PublicRoomView[],
  page: readonly PublicRoomView[]
): PublicRoomView[] {
  const seen = new Set(current.map((room) => room.room_id));
  return [...current, ...page.filter((room) => !seen.has(room.room_id))];
}
