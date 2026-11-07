<script lang="ts">
  import type {
    SearchPeerCandidateStatus,
    SearchPeerOutcome,
    SearchSharingView,
  } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import {
    searchPeerConnections,
    type SearchPeerConnection,
  } from '#lib/search/search-peer-diagnostics.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { formatDate, formatTime } from '#lib/ui/date-time.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  let sharing = $state<SearchSharingView | null>(null);
  let finding = $state(false);
  let connections = $state<SearchPeerConnection[]>([]);

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
        if (!active) return;
        sharing = metrics.sharing;
        connections = searchPeerConnections();
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

  const outcomeKeys: Record<SearchPeerOutcome, string> = {
    completed: 'settings.searchPeerCompleted',
    no_devices: 'settings.searchPeerNoDevices',
    no_answer: 'settings.searchPeerNoAnswer',
    nothing_to_copy: 'settings.searchPeerNothingToCopy',
    failed: 'settings.searchPeerFailed',
    interrupted: 'settings.searchPeerInterrupted',
  };
  const candidateKeys: Record<SearchPeerCandidateStatus, string> = {
    waiting: 'settings.searchPeerCandidateWaiting',
    trying: 'settings.searchPeerCandidateTrying',
    failed: 'settings.searchPeerCandidateFailed',
    done: 'settings.searchPeerCandidateDone',
  };

  let supported = $derived.by(() => {
    if (typeof RTCPeerConnection === 'undefined') return false;
    return true;
  });
  let device = $derived(sharing?.peer ? (sharing.peer.name ?? sharing.peer.device_id) : '');
  let busy = $derived(
    sharing?.state === 'discovering' ||
      sharing?.state === 'connecting' ||
      sharing?.state === 'transferring'
  );

  let badge = $derived.by(() => {
    if (!preferences.searchSharing) return i18n.t('settings.searchPeerStateOff');
    if (!supported) return i18n.t('settings.searchPeerStateUnavailable');
    if (sharing?.pause) return i18n.t('settings.searchPeerStatePaused');
    switch (sharing?.state) {
      case 'discovering':
        return i18n.t('settings.searchPeerStateDiscovering');
      case 'connecting':
        return i18n.t('settings.searchPeerStateConnecting');
      case 'transferring':
        return i18n.t('settings.searchPeerStateTransferring');
      default:
        return i18n.t('settings.searchPeerStateIdle');
    }
  });

  let description = $derived.by(() => {
    if (!sharing) return '';
    if (!preferences.searchSharing) return i18n.t('settings.searchPeerHint');
    if (!supported) return i18n.t('settings.searchPeerUnsupported');
    if (sharing.pause === 'offline') return i18n.t('settings.searchPeerPausedOffline');
    if (sharing.pause === 'metered') return i18n.t('settings.searchPeerPausedMetered');
    if (sharing.pause === 'background') return i18n.t('settings.searchPeerPausedBackground');
    if (sharing.state === 'discovering') return i18n.t('settings.searchPeerDiscovering');
    if (sharing.state === 'connecting') return i18n.t('settings.searchPeerConnecting', { device });
    if (sharing.state === 'transferring')
      return i18n.t('settings.searchPeerTransferring', { device, count: sharing.rooms_copied });
    if (sharing.outcome === 'no_answer' && sharing.automatic)
      return i18n.t('settings.searchPeerNoAnswerRetrying');
    if (sharing.outcome) return i18n.t(outcomeKeys[sharing.outcome]);
    return i18n.t('settings.searchPeerHint');
  });

  async function find(): Promise<void> {
    finding = true;
    await core.rpc.search.peerFind({}).catch(() => {});
    finding = false;
  }
</script>

{#if sharing}
  <ul class="settings">
    <SettingsRow
      id="search-sharing-status"
      title={i18n.t('settings.searchPeerStatus')}
      {description}
    >
      <StatusBadge label={badge} variant="neutral" />
    </SettingsRow>
    {#if sharing.last_copy}
      <SettingsRow
        id="search-sharing-last-copy"
        title={i18n.t('settings.searchPeerLastCopy')}
        description={i18n.t('settings.searchPeerLastCopyDetail', {
          device: sharing.last_copy.name ?? sharing.last_copy.device_id,
          count: sharing.last_copy.rooms,
          when: `${formatDate(sharing.last_copy.at_ms)} ${formatTime(sharing.last_copy.at_ms)}`,
        })}
      />
    {/if}
    {#if supported}
      <SettingsRow
        id="search-sharing-find"
        title={i18n.t('settings.searchPeerFind')}
        description={i18n.t('settings.searchPeerFindHint')}
      >
        <Button
          size="small"
          loading={finding}
          disabled={busy || sharing.pause !== null}
          onclick={find}
        >
          {i18n.t('settings.searchPeerFindAction')}
        </Button>
      </SettingsRow>
    {/if}
    <SettingsRow id="search-sharing-received" title={i18n.t('settings.searchPeerRoomsReceived')}>
      <code>{sharing.rooms_received}</code>
    </SettingsRow>
    {#if preferences.developerTools}
      <SettingsRow id="search-sharing-asked" title={i18n.t('settings.searchPeerDebugAsked')}>
        <code>{sharing.asked}</code>
      </SettingsRow>
      <SettingsRow id="search-sharing-serving" title={i18n.t('settings.searchPeerDebugServing')}>
        <code>{sharing.serving}</code>
      </SettingsRow>
      <SettingsRow id="search-sharing-outcome" title={i18n.t('settings.searchPeerDebugOutcome')}>
        <code>{sharing.outcome ?? '-'}</code>
      </SettingsRow>
      {#each sharing.candidates as candidate (candidate.device_id)}
        <SettingsRow
          title={candidate.name ?? candidate.device_id}
          description={candidate.device_id}
        >
          <code>
            {i18n.t('settings.searchPeerDebugCandidate', {
              documents: candidate.documents,
              rooms: candidate.complete_rooms,
              status: i18n.t(candidateKeys[candidate.status]),
            })}
          </code>
        </SettingsRow>
      {/each}
      {#each connections as connection (connection.sessionId)}
        <SettingsRow
          title={connection.sessionId.slice(0, 8)}
          description={i18n.t(
            connection.sending
              ? 'settings.searchPeerDebugSending'
              : 'settings.searchPeerDebugReceiving'
          )}
        >
          <code
            >{connection.route
              ? `${connection.state} · ${connection.route}`
              : connection.state}</code
          >
        </SettingsRow>
      {/each}
    {/if}
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
    overflow-wrap: anywhere;
    text-align: right;
  }
</style>
