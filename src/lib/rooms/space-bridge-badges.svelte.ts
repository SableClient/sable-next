import type { CoreClient } from '#lib/core/client.svelte.js';

export const SPACE_BRIDGE_BADGES_EVENT = 'moe.sable.space.bridge_badges';

export const spaceBridgeBadgeChanges = $state({ version: 0 });

export async function spaceHidesBridgeBadges(core: CoreClient, spaceId: string): Promise<boolean> {
  try {
    const content = await core.rpc.room_state.event({
      room_id: spaceId,
      event_type: SPACE_BRIDGE_BADGES_EVENT,
      state_key: '',
    });
    return (content as { hidden?: unknown } | null)?.hidden === true;
  } catch (error) {
    console.debug('[sable room] space bridge badge setting unavailable', error);
    return false;
  }
}

export async function setSpaceHidesBridgeBadges(
  core: CoreClient,
  spaceId: string,
  hidden: boolean
): Promise<void> {
  await core.rpc.room_state.sendEvent({
    room_id: spaceId,
    event_type: SPACE_BRIDGE_BADGES_EVENT,
    state_key: '',
    content: { hidden },
  });
  spaceBridgeBadgeChanges.version += 1;
}
