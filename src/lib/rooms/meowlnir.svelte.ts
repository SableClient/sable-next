import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord } from '#lib/guards.js';
import { PROTECTED_ROOMS_EVENT, WATCHED_LISTS_EVENT, type RawContent } from './meowlnir-config.js';

export interface MeowlnirConfig {
  protectedRooms: RawContent | null;
  watchedLists: RawContent | null;
}

/** Whether the room holds Meowlnir's settings, which makes it a management room. */
export async function isMeowlnirRoom(core: CoreClient, roomId: string): Promise<boolean> {
  try {
    const found = await Promise.all(
      [PROTECTED_ROOMS_EVENT, WATCHED_LISTS_EVENT].map((event_type) =>
        core.rpc.room_state.event({ room_id: roomId, event_type, state_key: '' })
      )
    );
    return found.some(isRecord);
  } catch (error) {
    console.debug('[sable room] meowlnir settings unavailable', error);
    return false;
  }
}

function stateContent(events: readonly unknown[], eventType: string): RawContent | null {
  const event = events.find(
    (candidate) => isRecord(candidate) && candidate.type === eventType && candidate.state_key === ''
  );
  return isRecord(event) && isRecord(event.content) ? event.content : null;
}

/**
 * Sync does not deliver Meowlnir's events, so a cached read can be stale for
 * as long as the session lives. The full state always comes from the server.
 */
export async function loadMeowlnirConfig(
  core: CoreClient,
  roomId: string
): Promise<MeowlnirConfig> {
  const events = await core.rpc.room_state.fullState({ room_id: roomId });
  return {
    protectedRooms: stateContent(events, PROTECTED_ROOMS_EVENT),
    watchedLists: stateContent(events, WATCHED_LISTS_EVENT),
  };
}

/** Applies `change` to what the server holds now, so another moderator's edit is not undone. */
export async function updateMeowlnirEvent(
  core: CoreClient,
  roomId: string,
  eventType: typeof PROTECTED_ROOMS_EVENT | typeof WATCHED_LISTS_EVENT,
  change: (content: RawContent) => RawContent
): Promise<RawContent> {
  const events = await core.rpc.room_state.fullState({ room_id: roomId });
  const content = change(stateContent(events, eventType) ?? {});
  await core.rpc.room_state.sendEvent({
    room_id: roomId,
    event_type: eventType,
    state_key: '',
    content,
  });
  return content;
}
