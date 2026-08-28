import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

import type { BookmarkView } from '#src/generated/BookmarkView';
import type { CoreCommands } from '#lib/core/commands.svelte.js';

export type BookmarkCommands = Pick<CoreCommands, 'bookmarks' | 'setBookmark'>;

function bookmarkKey(roomId: string, eventId: string): string {
  return `${roomId}|${eventId}`;
}

export class Bookmarks {
  readonly #keys = new SvelteSet<string>();
  #entries = $state.raw<BookmarkView[]>([]);
  #loaded = false;
  #inFlight: Promise<void> | null = null;
  #revision = 0;

  constructor(private readonly commands: BookmarkCommands) {}

  get entries(): readonly BookmarkView[] {
    return this.#entries;
  }

  has(roomId: string, eventId: string | null | undefined): boolean {
    return (
      eventId !== null && eventId !== undefined && this.#keys.has(bookmarkKey(roomId, eventId))
    );
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#inFlight ??= this.#fetch();
    await this.#inFlight;
  }

  async toggle(roomId: string, eventId: string): Promise<void> {
    const key = bookmarkKey(roomId, eventId);
    const bookmarked = await this.commands.setBookmark(roomId, eventId, !this.#keys.has(key));

    this.#revision += 1;
    if (bookmarked) {
      this.#keys.add(key);
      this.#loaded = false;
    } else {
      this.#keys.delete(key);
      this.#entries = this.#entries.filter(
        (entry) => bookmarkKey(entry.room_id, entry.event_id) !== key
      );
    }
  }

  async #fetch(): Promise<void> {
    const revision = this.#revision;
    try {
      const bookmarks = await this.commands.bookmarks();
      if (revision !== this.#revision) return;

      this.#replace(bookmarks);
      this.#loaded = true;
    } catch (error) {
      console.warn('[sable timeline] bookmarks unavailable', error);
    } finally {
      this.#inFlight = null;
    }
  }

  #replace(bookmarks: readonly BookmarkView[]): void {
    this.#keys.clear();
    for (const bookmark of bookmarks) {
      this.#keys.add(bookmarkKey(bookmark.room_id, bookmark.event_id));
    }
    this.#entries = [...bookmarks];
  }
}

export const [useBookmarks, provideBookmarks] = createContext<Bookmarks>();
