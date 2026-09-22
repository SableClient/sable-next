<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import WaveformIcon from 'phosphor-svelte/lib/WaveformIcon';

  import CallControls from './CallControls.svelte';
  import type { CallSession } from './call-session.svelte.js';
  import { callStatusKey } from './call-status';

  interface Props {
    session: CallSession;
    roomName: string;
    collapsed?: boolean;
    onReturn: () => void;
  }

  let { session, roomName, collapsed = false, onReturn }: Props = $props();

  let statusLabel = $derived(
    $i18n.t(
      callStatusKey({
        lifecycle: session.lifecycle,
        connection: session.transport.connection,
        mediaReady: session.mediaReady,
      })
    )
  );
</script>

<section class="call-bar" class:collapsed aria-label={$i18n.t('call.title')}>
  <button
    class="call-room"
    type="button"
    aria-label={collapsed ? `${statusLabel}, ${roomName}` : undefined}
    title={collapsed ? roomName : undefined}
    onclick={onReturn}
  >
    <WaveformIcon weight="bold" />
    {#if !collapsed}
      <span class="status">{statusLabel}</span>
      <span class="room">{roomName}</span>
    {/if}
  </button>
  <CallControls
    compact
    microphoneEnabled={session.transport.microphoneEnabled}
    cameraEnabled={session.transport.cameraEnabled}
    screenShareEnabled={session.transport.screenShareEnabled}
    deafened={session.deafened}
    ready={session.mediaReady && session.lifecycle === 'active'}
    canScreenShare={session.canScreenShare}
    onToggleMicrophone={() =>
      void session.setMicrophoneEnabled(!session.transport.microphoneEnabled)}
    onToggleCamera={() => void session.setCameraEnabled(!session.transport.cameraEnabled)}
    onToggleScreenShare={() =>
      void session.setScreenShareEnabled(!session.transport.screenShareEnabled)}
    onToggleDeafen={() => session.setDeafened(!session.deafened)}
    onHangUp={() => void session.leave()}
  />
</section>

<style>
  .call-bar {
    background: var(--surface-container);
    border-right: var(--border-width) solid var(--surface-container-line);
    border-top: var(--border-width) solid var(--surface-container-line);
    box-sizing: border-box;
    display: grid;
    gap: var(--space-100);
    padding: var(--space-150) var(--space-200);
  }

  .call-room {
    align-items: center;
    background: transparent;
    border: 0;
    column-gap: var(--space-150);
    cursor: pointer;
    display: grid;
    font: inherit;
    grid-template-columns: auto minmax(0, 1fr);
    padding: 0;
    text-align: left;
  }

  .call-room :global(svg) {
    color: var(--success-main);
    grid-row: span 2;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .status {
    color: var(--success-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
  }

  .room {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    max-inline-size: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .call-room:hover .room {
    color: var(--bg-on-container);
    text-decoration: underline;
  }

  .collapsed .call-room {
    justify-content: center;
  }

  .collapsed :global(.controls) {
    flex-wrap: wrap;
    justify-content: center;
  }

  .collapsed :global(.hang-up) {
    margin-inline-start: 0;
  }

  .call-room:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
