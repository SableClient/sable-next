import type { CoreClient } from '#lib/core/client.svelte.js';

export function mediaProgress(
  core: Pick<CoreClient, 'subscribeEvents'>,
  source: () => string | null
): { readonly percent: number | null } {
  let progress = $state<{ source: string; percent: number } | null>(null);

  $effect(() => {
    const wanted = source();
    progress = null;
    if (wanted === null) return;
    return core.subscribeEvents((event) => {
      if (event.type !== 'media_progress' || event.source !== wanted || event.total === 0) return;
      progress = {
        source: wanted,
        percent: Math.min(100, Math.floor((event.current / event.total) * 100)),
      };
    });
  });

  return {
    get percent() {
      return progress !== null && progress.source === source() ? progress.percent : null;
    },
  };
}
