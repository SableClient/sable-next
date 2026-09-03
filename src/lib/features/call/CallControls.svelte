<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import VideoCameraSlashIcon from 'phosphor-svelte/lib/VideoCameraSlashIcon';
  import MonitorArrowUpIcon from 'phosphor-svelte/lib/MonitorArrowUpIcon';
  import PhoneDisconnectIcon from 'phosphor-svelte/lib/PhoneDisconnectIcon';

  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  interface Props {
    microphoneEnabled: boolean;
    cameraEnabled: boolean;
    screenShareEnabled: boolean;
    ready: boolean;
    canScreenShare: boolean;
    onToggleMicrophone: () => void;
    onToggleCamera: () => void;
    onToggleScreenShare: () => void;
    onHangUp: () => void;
  }

  let {
    microphoneEnabled,
    cameraEnabled,
    screenShareEnabled,
    ready,
    canScreenShare,
    onToggleMicrophone,
    onToggleCamera,
    onToggleScreenShare,
    onHangUp,
  }: Props = $props();
</script>

<div class="controls">
  <IconButton
    variant="ghost"
    class="sable-choice"
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
    class="sable-choice"
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
      class="sable-choice"
      label={$i18n.t('call.screenShare')}
      aria-pressed={screenShareEnabled}
      disabled={!ready}
      onclick={onToggleScreenShare}
    >
      <MonitorArrowUpIcon />
    </IconButton>
  {/if}

  <IconButton class="hang-up" variant="danger" label={$i18n.t('call.hangUp')} onclick={onHangUp}>
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
</style>
