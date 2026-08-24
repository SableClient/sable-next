<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import WifiLowIcon from 'phosphor-svelte/lib/WifiLowIcon';
  import WifiSlashIcon from 'phosphor-svelte/lib/WifiSlashIcon';
  import { untrack } from 'svelte';
  import type { RemoteParticipant, Room as LivekitRoom } from 'livekit-client';
  import { Track } from 'livekit-client';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import { senderColor } from '#lib/features/room/timeline-format.js';

  import type { CallParticipant } from './call-transport';

  interface Props {
    participant: CallParticipant;
    room: LivekitRoom | undefined;
    name: string;
    userId: string;
    avatar: string | null;
    initials: (name: string) => string;
  }

  let { participant, room, name, userId, avatar, initials }: Props = $props();

  let cameraOn = $derived(
    participant.camera !== undefined && !participant.camera.muted && participant.camera.subscribed
  );
  let muted = $derived(participant.microphone === undefined || participant.microphone.muted);
  let quality = $derived(participant.connectionQuality ?? 'unknown');

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
      <Avatar src={avatar} initials={initials(name)} color={senderColor(userId)} size="large" />
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
  </div>
</li>

<style>
  .tile {
    aspect-ratio: 4 / 3;
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid transparent;
    border-radius: var(--radii-400);
    overflow: hidden;
    position: relative;
  }

  .tile.live {
    border-color: var(--sable-primary-main);
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
    background: linear-gradient(transparent, var(--sable-overlay));
    display: flex;
    gap: var(--space-100);
    inset: auto 0 0;
    padding: var(--space-300) var(--space-200) var(--space-100);
    position: absolute;
  }

  .name {
    color: var(--sable-picker-white);
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .badge {
    align-items: center;
    color: var(--sable-picker-white);
    display: inline-flex;
    flex: none;
  }

  .badge.crit {
    color: var(--sable-crit-main);
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
