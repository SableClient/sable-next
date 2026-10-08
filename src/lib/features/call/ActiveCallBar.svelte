<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
  import WaveformIcon from 'phosphor-svelte/lib/WaveformIcon';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

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
  let count = $derived(
    session.members.length > 0 ? session.members.length : session.transport.self ? 1 : 0
  );
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
  <Tooltip label={roomName} disabled={!collapsed}>
    {#snippet trigger({ props })}
      <button
        {...props}
        class="call-room"
        type="button"
        aria-label={collapsed ? `${statusLabel}, ${roomName}` : undefined}
        onclick={onReturn}
      >
        <WaveformIcon weight="bold" />
        {#if !collapsed}
          <span class="status">{statusLabel}</span>
          <span class="room">{roomName}</span>
        {/if}
        {#if count > 0}
          {@const countLabel = $i18n.t('call.participants', { count })}
          <Tooltip label={countLabel}>
            {#snippet trigger({ props: countProps })}
              <span {...countProps} class="count">
                <UsersIcon aria-hidden="true" weight="bold" />
                {count}
                <span class="screen-reader-only">{countLabel}</span>
              </span>
            {/snippet}
          </Tooltip>
        {/if}
      </button>
    {/snippet}
  </Tooltip>
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
    onToggleScreenShare={() => void session.toggleScreenShare()}
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
    color: var(--surface-on-container);
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
    grid-template-columns: auto minmax(0, 1fr) auto;
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
    color: var(--bg-on-container);
  }

  .call-room:hover,
  .call-room:focus-visible {
    background: var(--ghost-hover);
  }

  .call-room > :global(svg) {
    color: var(--call-bar-tone);
    grid-row: span 2;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .count {
    align-items: center;
    color: var(--surface-var-on-container);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    gap: var(--space-050);
    grid-column: 3;
    grid-row: 1 / span 2;
  }

  .count :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
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
    justify-items: center;
    row-gap: var(--space-050);
  }

  .collapsed .count {
    grid-column: 1;
    grid-row: auto;
  }

  .call-bar:not(.collapsed) :global(.control:last-child) {
    margin-inline-start: auto;
  }

  .collapsed :global(.controls) {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: repeat(2, var(--avatar-size-400));
    justify-content: center;
  }

  .collapsed :global(.controls .btn) {
    --button-height: var(--avatar-size-400);
    --button-icon-size: var(--size-x400);

    border-radius: var(--radius);
  }

  .collapsed :global(.controls .btn-ghost) {
    --button-line: var(--bg-container-line);
  }

  .collapsed :global(.control:last-child) {
    border-top: var(--border-width) solid var(--bg-container-line);
    grid-column: 1 / -1;
    padding-top: var(--space-200);
  }

  .collapsed :global(.hang-up) {
    width: 100%;
  }

  .call-bar:not(.live, .reconnecting) .call-room :global(svg) {
    animation: call-pending calc(var(--duration-slow) * 4) var(--motion-easing-standard) infinite;
  }

  @keyframes call-pending {
    50% {
      opacity: 0.4;
    }
  }
</style>
