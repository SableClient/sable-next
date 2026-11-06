<script lang="ts">
  import type { SearchPeerState, SearchSharingView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  let sharing = $state<SearchSharingView | null>(null);

  $effect(() => {
    if (core.session?.account_id === undefined) {
      sharing = null;
      return;
    }

    sharing = null;
    let active = true;
    let fetching = false;
    const refresh = async (): Promise<void> => {
      if (fetching) return;
      fetching = true;
      try {
        const metrics = await core.rpc.search.metrics();
        if (active) sharing = metrics.sharing;
      } catch {
        if (active) sharing = null;
      } finally {
        fetching = false;
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  });

  const stateKeys: Record<SearchPeerState, string> = {
    off: 'settings.searchPeerStateOff',
    waiting: 'settings.searchPeerStateWaiting',
    connecting: 'settings.searchPeerStateConnecting',
    transferring: 'settings.searchPeerStateTransferring',
    idle: 'settings.searchPeerStateIdle',
    unavailable: 'settings.searchPeerStateUnavailable',
  };
  let peerState = $derived(
    !preferences.searchSharing
      ? 'off'
      : typeof RTCPeerConnection === 'undefined'
        ? 'unavailable'
        : (sharing?.state ?? 'off')
  );
</script>

{#if sharing}
  <ul class="settings">
    <SettingsRow
      id="search-sharing-status"
      title={i18n.t('settings.searchPeerStatus')}
      description={i18n.t(
        peerState === 'waiting' ? 'settings.searchPeerWaitingHint' : 'settings.searchPeerHint'
      )}
    >
      <StatusBadge label={i18n.t(stateKeys[peerState])} variant="neutral" />
    </SettingsRow>
    <SettingsRow id="search-sharing-received" title={i18n.t('settings.searchPeerRoomsReceived')}>
      <code>{sharing.rooms_received}</code>
    </SettingsRow>
  </ul>
{/if}

<style>
  .settings {
    border-top: var(--border-width) solid var(--bg-container-line);
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  code {
    font-family: var(--font-family-mono);
    font-variant-ligatures: none;
    text-align: right;
  }
</style>
