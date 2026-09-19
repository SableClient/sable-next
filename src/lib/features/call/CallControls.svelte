<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import VideoCameraSlashIcon from 'phosphor-svelte/lib/VideoCameraSlashIcon';
  import MonitorArrowUpIcon from 'phosphor-svelte/lib/MonitorArrowUpIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import SpeakerSlashIcon from 'phosphor-svelte/lib/SpeakerSlashIcon';
  import PhoneDisconnectIcon from 'phosphor-svelte/lib/PhoneDisconnectIcon';

  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  interface Props {
    microphoneEnabled: boolean;
    cameraEnabled: boolean;
    screenShareEnabled: boolean;
    deafened: boolean;
    ready: boolean;
    canScreenShare: boolean;
    compact?: boolean;
    onToggleMicrophone: () => void;
    onToggleCamera: () => void;
    onToggleScreenShare: () => void;
    onToggleDeafen: () => void;
    onHangUp: () => void;
  }

  let {
    microphoneEnabled,
    cameraEnabled,
    screenShareEnabled,
    deafened,
    ready,
    canScreenShare,
    compact = false,
    onToggleMicrophone,
    onToggleCamera,
    onToggleScreenShare,
    onToggleDeafen,
    onHangUp,
  }: Props = $props();
</script>

<div class="controls" class:compact>
  <IconButton
    variant="ghost"
    class="choice"
    size={compact ? 'small' : 'medium'}
    label={$i18n.t('call.microphone')}
    aria-pressed={microphoneEnabled}
    disabled={!ready}
    onclick={onToggleMicrophone}
  >
    {#if microphoneEnabled}
      <MicrophoneIcon />
    {:else}
      <MicrophoneSlashIcon />
    {/if}
  </IconButton>

  <IconButton
    variant="ghost"
    class="choice"
    size={compact ? 'small' : 'medium'}
    label={$i18n.t('call.camera')}
    aria-pressed={cameraEnabled}
    disabled={!ready}
    onclick={onToggleCamera}
  >
    {#if cameraEnabled}
      <VideoCameraIcon />
    {:else}
      <VideoCameraSlashIcon />
    {/if}
  </IconButton>

  {#if canScreenShare}
    <IconButton
      variant="ghost"
      class="choice"
      size={compact ? 'small' : 'medium'}
      label={$i18n.t('call.screenShare')}
      aria-pressed={screenShareEnabled}
      disabled={!ready}
      onclick={onToggleScreenShare}
    >
      <MonitorArrowUpIcon />
    </IconButton>
  {/if}

  <IconButton
    variant="ghost"
    class="choice"
    size={compact ? 'small' : 'medium'}
    label={$i18n.t('call.speaker')}
    aria-pressed={!deafened}
    onclick={onToggleDeafen}
  >
    {#if deafened}
      <SpeakerSlashIcon />
    {:else}
      <SpeakerHighIcon />
    {/if}
  </IconButton>

  <IconButton
    class="hang-up"
    variant="danger"
    size={compact ? 'small' : 'medium'}
    label={$i18n.t('call.hangUp')}
    onclick={onHangUp}
  >
    <PhoneDisconnectIcon />
  </IconButton>
</div>

<style>
  .controls {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: center;
    padding: var(--space-200);
  }

  .controls :global(.hang-up) {
    margin-inline-start: var(--space-200);
  }

  .controls.compact {
    gap: var(--space-050);
    justify-content: space-between;
    padding: 0;
  }

  .controls.compact :global(.hang-up) {
    margin-inline-start: var(--space-100);
  }
</style>
