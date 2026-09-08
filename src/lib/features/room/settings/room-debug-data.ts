import type { CoreCommands } from '#lib/core/commands.svelte.js';
import type {
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomSummary,
} from '#src/generated/protocol';

const STATE_TYPES = [
  'm.room.create',
  'm.room.name',
  'm.room.avatar',
  'm.room.topic',
  'm.room.canonical_alias',
  'm.room.join_rules',
  'm.room.history_visibility',
  'm.room.encryption',
  'm.room.power_levels',
  'm.room.tombstone',
  'm.space.parent',
  'm.space.child',
] as const;

export async function collectRoomDebugData(
  commands: Pick<CoreCommands, 'roomStateEventsRaw'>,
  room: RoomSummary,
  permissions: RoomPermissionsView | null,
  levels: RoomPowerLevelsView | null
): Promise<string> {
  const snapshot = structuredClone({ room, permissions, power_levels: levels });
  const capturedAt = new Date().toISOString();
  const state = await Promise.all(
    STATE_TYPES.map(async (type) => {
      try {
        const events = await commands.roomStateEventsRaw(room.room_id, type, null);
        return [type, { events }] as const;
      } catch (error) {
        return [type, { error: error instanceof Error ? error.message : String(error) }] as const;
      }
    })
  );
  const cachedState: Record<string, { events: unknown[] } | { error: string }> = Object.fromEntries<
    { events: unknown[] } | { error: string }
  >(state);
  return JSON.stringify(
    { version: 1, captured_at: capturedAt, ...snapshot, cached_state: cachedState },
    null,
    2
  );
}
