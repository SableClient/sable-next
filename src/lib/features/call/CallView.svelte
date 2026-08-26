<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import LockIcon from 'phosphor-svelte/lib/LockSimpleIcon';
  import type { MemberView } from '#src/generated/MemberView';

  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import CallAudio from './CallAudio.svelte';
  import CallControls from './CallControls.svelte';
  import CallParticipantTile from './CallParticipantTile.svelte';
  import type { CallSession } from './call-session.svelte.js';
  import { callFailureKey, callStatusKey } from './call-status';

  interface Props {
    session: CallSession;
    members: readonly MemberView[];
  }

  let { session, members }: Props = $props();

  let statusLabel = $derived(
    $i18n.t(
      callStatusKey({
        lifecycle: session.lifecycle,
        connection: session.transport.connection,
        mediaReady: session.mediaReady,
      })
    )
  );

  let byIdentity = $derived(
    new Map(session.members.map((member) => [member.identity, member.user_id]))
  );

  function profileOf(identity: string): { userId: string; name: string; avatar: string | null } {
    const userId = byIdentity.get(identity) ?? identity;
    const member = members.find((entry) => entry.user_id === userId);
    return {
      userId,
      name: member?.display_name ?? userId,
      avatar: member?.avatar_url ?? null,
    };
  }

  let busy = $derived(session.lifecycle === 'joining' || session.lifecycle === 'connecting');
</script>

<section class="call" aria-label={$i18n.t('call.title')}>
  <header class="bar">
    {#if busy}
      <Spinner />
    {/if}
    <p class="status" role="status">{statusLabel}</p>
    {#if session.encryptsMedia}
      <span class="encrypted" title={$i18n.t('call.encrypted')}>
        <LockIcon aria-hidden="true" />
        <span class="visually-hidden">{$i18n.t('call.encrypted')}</span>
      </span>
    {/if}
  </header>

  {#if session.failure}
    <Alert variant="critical">{$i18n.t(callFailureKey(session.failure))}</Alert>
  {/if}

  {#if session.transport.participants.length === 0}
    <p class="empty">{$i18n.t('call.noParticipants')}</p>
  {:else}
    <ul class="grid">
      {#each session.transport.participants as participant (participant.identity)}
        {@const profile = profileOf(participant.identity)}
        <CallParticipantTile
          {participant}
          room={session.room?.room}
          name={profile.name}
          userId={profile.userId}
          avatar={profile.avatar}
        />
      {/each}
    </ul>
  {/if}

  <CallAudio room={session.room?.room} />

  <CallControls
    microphoneEnabled={session.transport.microphoneEnabled}
    cameraEnabled={session.transport.cameraEnabled}
    screenShareEnabled={session.transport.screenShareEnabled}
    ready={session.mediaReady && session.lifecycle === 'active'}
    canScreenShare={session.canScreenShare}
    onToggleMicrophone={() =>
      void session.setMicrophoneEnabled(!session.transport.microphoneEnabled)}
    onToggleCamera={() => void session.setCameraEnabled(!session.transport.cameraEnabled)}
    onToggleScreenShare={() =>
      void session.setScreenShareEnabled(!session.transport.screenShareEnabled)}
    onHangUp={() => void session.leave()}
  />
</section>

<style>
  .call {
    background: var(--sable-surface-container);
    border-block-end: var(--space-hairline) solid var(--sable-surface-container-line);
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    padding: var(--space-200);
  }

  .bar {
    align-items: center;
    display: flex;
    gap: var(--space-150);
  }

  .status {
    font-size: var(--font-size-small);
    margin: 0;
  }

  .encrypted {
    align-items: center;
    color: var(--sable-success-main);
    display: inline-flex;
    margin-inline-start: auto;
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    text-align: center;
  }

  .grid {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .visually-hidden {
    block-size: 1px;
    clip-path: inset(50%);
    inline-size: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
  }
</style>
