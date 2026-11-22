import { createContext } from 'svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { onEachUtcDay } from '#lib/day.js';
import { parseShortcodes } from '#lib/emoji/parse-shortcodes.js';
import { readJson, removeLocalValue } from '#lib/platform/local-json.js';
import { ACCOUNT_DATA_KEY_TYPE } from '#lib/settings/account-sync.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import type { RecentUse } from '#src/generated/protocol';

export const STICKER_HISTORY_EVENT = 'moe.sable.next.sticker_history';

const LEGACY_KEY = 'sable.composer.recentStickers';

export class StickerHistory {
  /** Newest first. The model ranks it against the packs of the room. */
  current = $state.raw<RecentUse[]>([]);
  /** Whether the synced history has arrived, before which the list older builds read is left alone. */
  loaded = $state(false);

  readonly #core: Pick<CoreClient, 'rpc' | 'session' | 'subscribeEvents'>;
  #account: string | undefined;
  #requested = 0;
  #shown = 0;

  constructor(core: Pick<CoreClient, 'rpc' | 'session' | 'subscribeEvents'>) {
    this.#core = core;
    $effect(() => {
      const account = core.session?.account_id;
      const sync = preferences.settingsSync;
      if (account !== this.#account) {
        this.#account = account;
        this.#shown = this.#requested + 1;
        this.current = [];
        this.loaded = false;
      }
      this.#load(false);
      // The local copy shows while the server is asked.
      if (sync) this.#load(true);

      const stopDays = onEachUtcDay(() => {
        this.#load(sync);
      });
      const stop = core.subscribeEvents((event) => {
        if (event.type !== 'account_data_changed') return;
        if ([STICKER_HISTORY_EVENT, ACCOUNT_DATA_KEY_TYPE].includes(event.event_type)) {
          this.#load(sync);
        }
      });
      return () => {
        stopDays();
        stop();
      };
    });
  }

  remember(key: string): void {
    this.#core.rpc.messages
      .rememberSticker({ key, sync: preferences.settingsSync })
      .catch((error: unknown) => {
        console.warn('[sable stickers] the pick could not be remembered', error);
      });
  }

  /** Takes in what older builds wrote to the list they still sync. */
  follow(list: string[]): void {
    this.#load(true, list);
  }

  #load(sync: boolean, synced?: string[]): void {
    const request = ++this.#requested;
    const legacy = readJson(LEGACY_KEY, parseShortcodes, []);
    this.#core.rpc.messages
      .recentStickers({ sync, legacy, ...(synced && { synced }) })
      .then((recent) => {
        removeLocalValue(LEGACY_KEY);
        if (request < this.#shown) return;

        this.#shown = request;
        this.current = recent;
        if (sync) this.loaded = true;
      })
      .catch((error: unknown) => {
        console.debug('[sable stickers] history unavailable', error);
      });
  }
}

const [useShared, provideStickerHistory, hasShared] = createContext<StickerHistory>();

export { provideStickerHistory };

export function useStickerHistory(
  core: ConstructorParameters<typeof StickerHistory>[0]
): StickerHistory {
  return hasShared() ? useShared() : new StickerHistory(core);
}
