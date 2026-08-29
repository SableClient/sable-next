import type { CoreClient } from '#lib/core/client.svelte.js';

import { dequeue, dueMessages } from './scheduled-queue.svelte.js';

const TICK_MS = 15_000;

export function watchScheduledQueue(core: CoreClient): () => void {
  let sending = false;

  const tick = async (): Promise<void> => {
    const deviceId = core.session?.device_id;
    if (sending || deviceId === undefined) return;

    const due = dueMessages(Date.now(), deviceId);
    if (due.length === 0) return;

    sending = true;
    try {
      for (const message of due) {
        dequeue(message.id);
        await core.commands
          .sendMessage(message.roomId, message.body, { formatted: message.formatted })
          .catch((error: unknown) => {
            console.warn('[sable composer] a scheduled message could not be sent', error);
          });
      }
    } finally {
      sending = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), TICK_MS);

  return () => {
    clearInterval(timer);
  };
}
