<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import SpeakerSlashIcon from 'phosphor-svelte/lib/SpeakerSlashIcon';
  import WifiLowIcon from 'phosphor-svelte/lib/WifiLowIcon';
  import WifiSlashIcon from 'phosphor-svelte/lib/WifiSlashIcon';
  import { untrack } from 'svelte';
  import type { RemoteParticipant, Room as LivekitRoom } from 'livekit-client';
  import { Track } from 'livekit-client';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';

  import type { CallParticipant } from './call-transport';
  import {
    MAX_PARTICIPANT_VOLUME,
    participantVolume,
    setParticipantVolume,
  } from './participant-volumes.svelte.js';

  interface Props {
    participant: CallParticipant;
    room: LivekitRoom | undefined;
    name: string;
    userId: string;
    avatar: string | null;
  }

  let { participant, room, name, userId, avatar }: Props = $props();

  let cameraOn = $derived(
    participant.camera !== undefined && !participant.camera.muted && participant.camera.subscribed
  );
  let muted = $derived(participant.microphone === undefined || participant.microphone.muted);
  let quality = $derived(participant.connectionQuality ?? 'unknown');
  let volume = $derived(participantVolume(userId));
  let volumeOpen = $state(false);
  let unmutedVolume = 1;

  function toggleMute(): void {
    if (volume === 0) {
      setParticipantVolume(userId, unmutedVolume);
      return;
    }
    unmutedVolume = volume;
    setParticipantVolume(userId, 0);
  }

  function attachVideo(node: HTMLVideoElement) {
    const identity = untrack(() => participant.identity);
    const remote: RemoteParticipant | undefined = room?.remoteParticipants.get(identity);
    const track = remote?.getTrackPublication(Track.Source.Camera)?.track;
    track?.attach(node);

    return () => {
      track?.detach(node);
    };
  }
</script>

<li class="tile" class:live={!muted}>
  {#if cameraOn}
    <video class="video" autoplay muted playsinline {@attach attachVideo}></video>
  {:else}
    <div class="placeholder">
      <Avatar src={avatar} {name} id={userId} size="large" />
    </div>
  {/if}

  <div class="overlay">
    <span class="name">{name}</span>
    {#if muted}
      <span class="badge" title={$i18n.t('call.muted')}>
        <MicrophoneSlashIcon aria-hidden="true" />
        <span class="visually-hidden">{$i18n.t('call.muted')}</span>
      </span>
    {/if}
    {#if quality === 'poor'}
      <span class="badge" title={$i18n.t('call.connectionPoor')}>
        <WifiLowIcon aria-hidden="true" />
        <span class="visually-hidden">{$i18n.t('call.connectionPoor')}</span>
      </span>
    {:else if quality === 'lost'}
      <span class="badge crit" title={$i18n.t('call.connectionLost')}>
        <WifiSlashIcon aria-hidden="true" />
        <span class="visually-hidden">{$i18n.t('call.connectionLost')}</span>
      </span>
    {/if}
    <IconButton
      variant="ghost"
      size="small"
      class="volume-toggle"
      label={$i18n.t('call.participantVolume', { name })}
      aria-expanded={volumeOpen}
      onclick={() => (volumeOpen = !volumeOpen)}
    >
      {#if volume === 0}
        <SpeakerSlashIcon />
      {:else}
        <SpeakerHighIcon />
      {/if}
    </IconButton>
  </div>

  {#if volumeOpen}
    <div class="volume">
      <Slider
        min={0}
        max={MAX_PARTICIPANT_VOLUME}
        step={0.05}
        label={$i18n.t('call.participantVolume', { name })}
        value={volume}
        oninput={(next: number) => setParticipantVolume(userId, next)}
      />
      <span class="reading">{Math.round(volume * 100)}%</span>
      <IconButton
        variant="ghost"
        size="small"
        label={$i18n.t(volume === 0 ? 'call.unmuteParticipant' : 'call.muteParticipant', { name })}
        aria-pressed={volume === 0}
        onclick={toggleMute}
      >
        {#if volume === 0}
          <SpeakerSlashIcon />
        {:else}
          <SpeakerHighIcon />
        {/if}
      </IconButton>
    </div>
  {/if}
</li>

<style>
  .tile {
    aspect-ratio: 4 / 3;
    background: var(--surface-var-container);
    border: var(--border-width) solid transparent;
    border-radius: var(--radii-400);
    overflow: hidden;
    position: relative;
  }

  .tile.live {
    border-color: var(--primary-main);
  }

  .video {
    block-size: 100%;
    inline-size: 100%;
    object-fit: cover;
  }

  .placeholder {
    align-items: center;
    block-size: 100%;
    display: flex;
    inline-size: 100%;
    justify-content: center;
  }

  .overlay {
    align-items: center;
    background: linear-gradient(transparent, var(--overlay));
    display: flex;
    gap: var(--space-100);
    inset: auto 0 0;
    padding: var(--space-300) var(--space-200) var(--space-100);
    position: absolute;
  }

  .name {
    color: var(--picker-white);
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    align-items: center;
    color: var(--picker-white);
    display: inline-flex;
    flex: none;
  }

  .overlay :global(.volume-toggle) {
    color: var(--picker-white);
    flex: none;
    margin-inline-start: auto;
  }

  .volume {
    align-items: center;
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radii-300);
    box-shadow: var(--shadow-float);
    display: flex;
    gap: var(--space-150);
    inline-size: min(14rem, calc(100% - var(--space-400)));
    inset: auto var(--space-200) var(--space-600);
    padding: var(--space-150) var(--space-200);
    position: absolute;
  }

  .reading {
    color: var(--bg-on-container);
    flex: none;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    inline-size: 2.5rem;
    text-align: end;
  }

  .badge.crit {
    color: var(--crit-main);
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
