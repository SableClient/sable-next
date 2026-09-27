import type { RoomPowerLevelsView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

import {
  canSendState,
  syncedFromSpace,
  toEventContent,
  withLevel,
  type PermissionLocation,
} from './permission-groups';
import { POWER_LEVEL_TAGS_EVENT_TYPE, withPowerLevelTagsFrom } from './power-level-tags';
import { MEMBER_LIST_EVENT_TYPE } from './member-list.svelte.js';

export class RoomPermissionActions {
  constructor(private readonly core: CoreClient) {}

  async setLevel(
    roomId: string,
    levels: RoomPowerLevelsView,
    location: PermissionLocation,
    level: number
  ): Promise<RoomPowerLevelsView> {
    const next = withLevel(levels, location, level);
    await this.core.commands.sendStateEvent(
      roomId,
      'm.room.power_levels',
      '',
      toEventContent(next)
    );
    return next;
  }

  async syncFromSpace(
    roomId: string,
    spaceId: string,
    levels: RoomPowerLevelsView,
    userId: string,
    ownLevel: number,
    rawRoleTags: unknown
  ): Promise<{ levels: RoomPowerLevelsView; rawRoleTags: unknown }> {
    const [spaceLevels, spaceTags] = await Promise.all([
      this.core.commands.roomPowerLevels(spaceId),
      this.core.commands.roomStateEvent(spaceId, POWER_LEVEL_TAGS_EVENT_TYPE),
    ]);
    const next = syncedFromSpace(levels, spaceLevels, userId, ownLevel);
    await this.core.commands.sendStateEvent(
      roomId,
      'm.room.power_levels',
      '',
      toEventContent(next)
    );
    if (!spaceTags || !canSendState(next, ownLevel, POWER_LEVEL_TAGS_EVENT_TYPE)) {
      return { levels: next, rawRoleTags };
    }
    const nextTags = withPowerLevelTagsFrom(rawRoleTags, spaceTags);
    await this.core.commands.sendStateEvent(roomId, POWER_LEVEL_TAGS_EVENT_TYPE, '', nextTags);
    return { levels: next, rawRoleTags: nextTags };
  }

  async syncChildren(
    childIds: readonly string[],
    spaceLevels: RoomPowerLevelsView,
    userId: string,
    rawRoleTags: unknown
  ): Promise<{ updated: number; skipped: number }> {
    let updated = 0;
    let skipped = 0;
    for (const childId of childIds) {
      try {
        const [levels, permissions] = await Promise.all([
          this.core.commands.roomPowerLevels(childId),
          this.core.commands.roomPermissions(childId),
        ]);
        if (!permissions.can_change_power_levels) {
          skipped += 1;
          continue;
        }
        const next = syncedFromSpace(levels, spaceLevels, userId, permissions.own_power_level);
        if (JSON.stringify(toEventContent(next)) !== JSON.stringify(toEventContent(levels))) {
          await this.core.commands.sendStateEvent(
            childId,
            'm.room.power_levels',
            '',
            toEventContent(next)
          );
        }
        if (
          rawRoleTags &&
          canSendState(next, permissions.own_power_level, POWER_LEVEL_TAGS_EVENT_TYPE)
        ) {
          const tags = await this.core.commands.roomStateEvent(
            childId,
            POWER_LEVEL_TAGS_EVENT_TYPE
          );
          await this.core.commands.sendStateEvent(
            childId,
            POWER_LEVEL_TAGS_EVENT_TYPE,
            '',
            withPowerLevelTagsFrom(tags, rawRoleTags)
          );
        }
        updated += 1;
      } catch (error) {
        console.warn('[sable room] child permission sync failed', error);
        skipped += 1;
      }
    }
    return { updated, skipped };
  }

  async saveMemberList(roomId: string, alwaysListedFrom: number | null): Promise<void> {
    await this.core.commands.sendStateEvent(
      roomId,
      MEMBER_LIST_EVENT_TYPE,
      '',
      alwaysListedFrom === null ? {} : { always_listed_from: alwaysListedFrom }
    );
  }
}
