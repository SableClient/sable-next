import type { CoreClient } from '#lib/core/client.svelte.js';
import { parseShortcodes } from '#lib/emoji/recent-packs.svelte.js';
import { readJson, removeLocalValue } from '#lib/platform/local-json.js';

export const REACTION_HISTORY_EVENT = 'm.recent_emoji';
const DAY_MS = 86_400_000;

export class RecentReactions {
  current = $state.raw<string[]>([]);

  constructor(core: Pick<CoreClient, 'rpc' | 'session' | 'subscribeEvents'>) {
    $effect(() => {
      const accountId = core.session?.account_id;
      this.current = [];
      let live = true;
      let revision = 0;
      const load = (): void => {
        const request = ++revision;
        void core.rpc.messages
          .frequentReactions({
            legacy: readJson('sable-recent-reactions', (value) => value, null),
            recent: readJson('sable.composer.recentEmotes', parseShortcodes, []),
          })
          .then((entries) => {
            removeLocalValue('sable-recent-reactions');
            removeLocalValue('sable.composer.recentEmotes');
            if (live && request === revision) this.current = entries;
          })
          .catch((error: unknown) => {
            console.debug('[sable reactions] history unavailable', accountId, error);
          });
      };
      let timer: ReturnType<typeof setTimeout>;
      const nextDay = (): void => {
        timer = setTimeout(
          () => {
            load();
            nextDay();
          },
          DAY_MS - (Date.now() % DAY_MS)
        );
      };
      load();
      nextDay();
      const stop = core.subscribeEvents((event) => {
        if (event.type === 'account_data_changed' && event.event_type === REACTION_HISTORY_EVENT) {
          load();
        }
      });
      return () => {
        live = false;
        clearTimeout(timer);
        stop();
      };
    });
  }
}
