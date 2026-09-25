import type { PushFetchView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord } from '#lib/guards.js';

import { forgetPushSession, putPushSession } from './room-names';

type SessionSharer = Pick<CoreClient, 'commands' | 'session' | 'subscribeEvents'>;

export function sharePushSession(core: SessionSharer): () => void {
  const share = (): void => {
    const session = core.session;
    if (!session) return;
    const { user_id: userId, homeserver } = session;
    void core.commands
      .accessToken()
      .then((accessToken) =>
        accessToken === null
          ? forgetPushSession(userId)
          : putPushSession({ userId, homeserver, accessToken })
      )
      .catch(() => undefined);
  };
  share();
  return core.subscribeEvents((event) => {
    if (event.type === 'session_tokens_refreshed') share();
  });
}

export async function answerPushEvent(
  core: Pick<CoreClient, 'session' | 'commands'>,
  request: unknown
): Promise<PushFetchView | null> {
  if (!isRecord(request)) return null;
  const { roomId, eventId, userId } = request;
  if (typeof roomId !== 'string' || typeof eventId !== 'string') return null;
  if (typeof userId === 'string' && userId !== core.session?.user_id) return null;
  return core.commands.pushEvent(roomId, eventId).catch(() => null);
}
