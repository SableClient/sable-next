<script lang="ts">
  import type { RoomListItemView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import LinkButton from '#lib/ui/primitives/LinkButton.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';

  import { BRIDGE_EVENT_TYPES, parseBridgeEvents, type BridgeInfo } from './bridge-info';

  import '#lib/ui/primitives/settings-row.css';

  interface Props {
    room: RoomListItemView | null;
  }

  let { room }: Props = $props();
  const core = useCoreClient();

  let roomId = $derived(room?.room_id ?? null);
  let bridges = $derived(roomId === null ? [] : await load(roomId));

  async function load(room_id: string): Promise<BridgeInfo[]> {
    try {
      const events = await Promise.all(
        BRIDGE_EVENT_TYPES.map((event_type) =>
          core.rpc.room_state.eventsRaw({ room_id, event_type, state_key: null })
        )
      );
      return parseBridgeEvents(events.flat());
    } catch (error) {
      console.debug('[sable room] bridge state unavailable', error);
      return [];
    }
  }
</script>

<div class="section">
  <p class="settings-note">{i18n.t('room.bridgesHint')}</p>
  {#if bridges.length === 0}
    <p class="settings-status">{i18n.t('room.bridgesEmpty')}</p>
  {/if}
  {#each bridges as bridge, index (bridge.key)}
    <SettingsSection headingId="room-settings-bridge-{index}" title={bridge.protocol.name}>
      {#snippet icon()}
        <Avatar src={bridge.protocol.avatar} name={bridge.protocol.name} size="small" />
      {/snippet}
      <ul class="settings-rows">
        {#each [['room.bridgeService', bridge.protocol], ['room.bridgeNetwork', bridge.network], ['room.bridgeChannel', bridge.channel]] as const as [label, part] (label)}
          {#if part}
            <SettingsRow title={i18n.t(label)} description={part.name}>
              {#if part.url}
                <LinkButton href={part.url} target="_blank" rel="noopener noreferrer" size="small">
                  {i18n.t('room.bridgeOpen')}
                </LinkButton>
              {/if}
            </SettingsRow>
          {/if}
        {/each}
        {#if bridge.bot}
          <SettingsRow title={i18n.t('room.bridgeBot')} description={bridge.bot} />
        {/if}
        {#if bridge.creator}
          <SettingsRow title={i18n.t('room.bridgeCreator')} description={bridge.creator} />
        {/if}
      </ul>
    </SettingsSection>
  {/each}
</div>

<style>
  .section {
    display: grid;
    gap: var(--space-600);
  }
</style>
