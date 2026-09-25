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

  let live = $derived(
    session.lifecycle === 'active' &&
      session.mediaReady &&
      session.transport.connection === 'connected'
  );
  let reconnecting = $derived(session.transport.connection === 'reconnecting');
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

<section
  class="call-bar"
  class:collapsed
  class:live
  class:reconnecting
  aria-label={$i18n.t('call.title')}
>
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
  <span class="screen-reader-only" role="status">{statusLabel}</span>
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
    --call-bar-tone: var(--surface-on-container);
    --ghost-hover: var(--surface-container-hover);
    --ghost-active: var(--surface-container-active);

    background: var(--surface-container);
    border-right: var(--border-width) solid var(--surface-container-line);
    border-top: var(--border-width) solid var(--surface-container-line);
    box-sizing: border-box;
    display: grid;
    gap: var(--space-050);
    padding: var(--space-100);
  }

  .call-room {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    column-gap: var(--space-200);
    cursor: pointer;
    display: grid;
    font: inherit;
    grid-template-columns: auto minmax(0, 1fr);
    padding: var(--space-100);
    text-align: left;
  }

  .call-bar.live {
    --call-bar-tone: var(--success-main);
  }

  .call-bar.reconnecting {
    --call-bar-tone: var(--warn-main);
  }

  .call-bar.collapsed {
    --ghost-hover: var(--bg-container-hover);
    --ghost-active: var(--bg-container-active);

    background: var(--bg-container);
    border-right-color: var(--bg-container-line);
    border-top-color: var(--bg-container-line);
  }

  .call-room:hover,
  .call-room:focus-visible {
    background: var(--ghost-hover);
  }

  .call-room :global(svg) {
    color: var(--call-bar-tone);
    grid-row: span 2;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .status {
    color: var(--call-bar-tone);
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

  .collapsed .call-room {
    grid-template-columns: auto;
    justify-content: center;
  }

  .collapsed :global(.controls) {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(2, var(--control-height-300));
    justify-content: center;
  }

  .collapsed :global(.control:last-child) {
    margin-inline-start: 0;
  }

  .collapsed :global(.control:last-child:nth-child(odd)) {
    grid-column: 1 / -1;
  }

  .collapsed :global(.control:last-child:nth-child(odd) .hang-up) {
    width: 100%;
  }
</style>
