import type { CoreClient } from '#lib/core/client.svelte.js';
import { isRecord } from '#lib/guards.js';

const WIDGET_STATE_TYPE = 'im.vector.modular.widgets';
const READABLE_STATE_TYPES = new Set([
  'm.room.power_levels',
  'm.room.encryption',
  'm.room.member',
  'm.room.name',
  'm.widgets',
  WIDGET_STATE_TYPE,
  'io.element.integrations.installations',
]);

type Rpc = Pick<CoreClient['rpc'], 'room_state'>;
type Request = Record<string, unknown>;
type StateEvent = { content?: Record<string, unknown> };

export class ScalarError extends Error {}

async function stateEvents(
  rpc: Rpc,
  roomId: string,
  type: string,
  key: string | null
): Promise<StateEvent[]> {
  return (await rpc.room_state.eventsRaw({
    room_id: roomId,
    event_type: type,
    state_key: key,
  })) as StateEvent[];
}

async function stateContent(
  rpc: Rpc,
  roomId: string,
  type: string,
  key: string
): Promise<Record<string, unknown> | null> {
  const event = (await stateEvents(rpc, roomId, type, key)).at(0);
  return event?.content ?? null;
}

function powerLevel(table: unknown, key: string, fallback: number): number {
  const level = isRecord(table) ? table[key] : undefined;
  return typeof level === 'number' ? level : fallback;
}

async function canSend(
  rpc: Rpc,
  roomId: string,
  userId: string,
  type: string,
  isState: boolean
): Promise<boolean> {
  const membership = await stateContent(rpc, roomId, 'm.room.member', userId);
  if (membership?.membership !== 'join') return false;
  const levels = await stateContent(rpc, roomId, 'm.room.power_levels', '');
  if (levels === null) return true;
  const own = powerLevel(levels.users, userId, powerLevel(levels, 'users_default', 0));
  const required = powerLevel(
    levels.events,
    type,
    powerLevel(levels, isState ? 'state_default' : 'events_default', isState ? 50 : 0)
  );
  return own >= required;
}

async function readEvents(rpc: Rpc, roomId: string, request: Request): Promise<unknown> {
  const { type, state_key: key, limit } = request;
  if (typeof type !== 'string' || !READABLE_STATE_TYPES.has(type)) {
    throw new ScalarError('Failed to read events');
  }
  if (limit !== undefined && (typeof limit !== 'number' || limit < 0)) {
    throw new ScalarError('Failed to read events');
  }
  if (key !== true && typeof key !== 'string') {
    throw new ScalarError('Failed to read events');
  }
  const events = await stateEvents(rpc, roomId, type, key === true ? null : key);
  return { events: events.slice(0, typeof limit === 'number' ? limit : undefined) };
}

async function setWidget(
  rpc: Rpc,
  roomId: string,
  userId: string,
  request: Request
): Promise<unknown> {
  const { widget_id: id, url, type, name, data, avatar_url: avatar, userWidget } = request;
  if (userWidget === true) throw new ScalarError('User widgets are not supported');
  if (typeof id !== 'string' || id === '' || url === undefined) {
    throw new ScalarError('Failed to create widget');
  }
  if (url !== null && (typeof url !== 'string' || typeof type !== 'string')) {
    throw new ScalarError('Failed to create widget');
  }
  await rpc.room_state.sendEvent({
    room_id: roomId,
    event_type: WIDGET_STATE_TYPE,
    state_key: id,
    content:
      url === null
        ? {}
        : {
            type,
            url,
            ...(typeof name === 'string' && { name }),
            ...(isRecord(data) && { data }),
            ...(typeof avatar === 'string' && { avatar_url: avatar }),
            creatorUserId: userId,
          },
  });
  return { success: true };
}

async function getWidgets(rpc: Rpc, roomId: string | null): Promise<unknown> {
  if (roomId === null) return [];
  const events = await stateEvents(rpc, roomId, WIDGET_STATE_TYPE, null);
  return events.filter((event) => isRecord(event.content) && event.content.url !== undefined);
}

export async function answerScalarRequest(
  rpc: Rpc,
  roomId: string,
  userId: string,
  request: Request
): Promise<unknown> {
  const requested = request.room_id;
  if (requested === undefined) {
    if (request.action === 'get_widgets') return getWidgets(rpc, null);
    throw new ScalarError('Missing room_id in request');
  }
  if (requested !== roomId)
    throw new ScalarError(`Room ${JSON.stringify(requested)} is not visible`);

  const target = request.user_id;
  switch (request.action) {
    case 'get_widgets':
      return getWidgets(rpc, roomId);
    case 'set_widget':
      return setWidget(rpc, roomId, userId, request);
    case 'read_events':
      return readEvents(rpc, roomId, request);
    case 'get_room_enc_state':
      return (await stateEvents(rpc, roomId, 'm.room.encryption', '')).length > 0;
    case 'get_membership_count': {
      const members = await stateEvents(rpc, roomId, 'm.room.member', null);
      return members.filter((member) => member.content?.membership === 'join').length;
    }
    case 'join_rules_state':
      return stateContent(rpc, roomId, 'm.room.join_rules', '');
    case 'can_send_event': {
      if (
        !(await canSend(rpc, roomId, userId, String(request.event_type), request.is_state === true))
      ) {
        throw new ScalarError('You do not have permission to do that in this room');
      }
      return true;
    }
    case 'membership_state':
    case 'bot_options': {
      if (typeof target !== 'string' || target === '') {
        throw new ScalarError('Missing user_id in request');
      }
      return request.action === 'membership_state'
        ? stateContent(rpc, roomId, 'm.room.member', target)
        : stateContent(rpc, roomId, 'm.room.bot.options', `_${target}`);
    }
    default:
      throw new ScalarError(`Unsupported action ${String(request.action)}`);
  }
}
