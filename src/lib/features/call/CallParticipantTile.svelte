<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import MonitorIcon from 'phosphor-svelte/lib/MonitorIcon';
  import PushPinIcon from 'phosphor-svelte/lib/PushPinIcon';
  import PushPinSlashIcon from 'phosphor-svelte/lib/PushPinSlashIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import SpeakerSlashIcon from 'phosphor-svelte/lib/SpeakerSlashIcon';
  import CellSignalLowIcon from 'phosphor-svelte/lib/CellSignalLowIcon';
  import CellSignalSlashIcon from 'phosphor-svelte/lib/CellSignalSlashIcon';
  import { untrack } from 'svelte';
  import { on } from 'svelte/events';
  import type { Participant, Room as LivekitRoom } from 'livekit-client';
  import { Track } from 'livekit-client';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';

  import { cameraVisible, type CallTileSource } from './call-layout';
  import type { CallParticipant, CallVideoOverlay } from './call-transport';
  import { nativeVideoSlot } from './native-video-overlay';
  import {
    MAX_PARTICIPANT_VOLUME,
    participantVolume,
    setParticipantVolume,
  } from './participant-volumes.svelte.js';

  interface Props {
    participant: CallParticipant;
    source: CallTileSource;
    room: LivekitRoom | undefined;
    localVideo?: CallVideoOverlay;
    name: string;
    userId: string;
    avatar: string | null;
    pinned?: boolean;
    featured?: boolean;
    onPin?: () => void;
    onVolumeChange?: (identity: string, volume: number) => void;
  }

  let {
    participant,
    source,
    room,
    localVideo,
    name,
    userId,
    avatar,
    pinned = false,
    featured = false,
    onPin,
    onVolumeChange,
  }: Props = $props();

  function applyVolume(next: number): void {
    setParticipantVolume(userId, next);
    onVolumeChange?.(participant.identity, next);
  }

  let screen = $derived(source === 'screen');
  let videoOn = $derived(screen || cameraVisible(participant));
  let muted = $derived(participant.microphone === undefined || participant.microphone.muted);
  let speaking = $derived(!screen && !muted && participant.speaking === true);
  let quality = $derived(participant.connectionQuality ?? 'unknown');
  let label = $derived(screen ? $i18n.t('call.screenOf', { name }) : name);
  let volume = $derived(participantVolume(userId));
  let volumeOpen = $state(false);
  let revealed = $state(false);

  function reveal(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    if (event.target instanceof Element && event.target.closest('button, input')) return;
    revealed = !revealed;
  }

  function openVolume(event: MouseEvent): void {
    if (participant.local || screen) return;
    event.preventDefault();
    volumeOpen = true;
  }
  let unmutedVolume = 1;

  function toggleMute(): void {
    if (volume === 0) {
      applyVolume(unmutedVolume);
      return;
    }
    unmutedVolume = volume;
    applyVolume(0);
  }

  function dismissVolume(panel: HTMLElement) {
    const tile = panel.closest('li');
    const offPointer = on(
      document,
      'pointerdown',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (panel.contains(target)) return;
        if (tile?.contains(target) && target.closest('[data-volume-toggle]')) return;
        volumeOpen = false;
      },
      { capture: true }
    );
    const offKey = on(document, 'keydown', (event) => {
      if (event.key === 'Escape') volumeOpen = false;
    });
    return () => {
      offPointer();
      offKey();
    };
  }

  function attachVideo(node: HTMLVideoElement) {
    const identity = untrack(() => participant.identity);
    const trackSource = untrack(() => (screen ? Track.Source.ScreenShare : Track.Source.Camera));
    const owner: Participant | undefined = untrack(() => participant.local)
      ? room?.localParticipant
      : room?.remoteParticipants.get(identity);
    const track = owner?.getTrackPublication(trackSource)?.track;
    track?.attach(node);

    return () => {
      track?.detach(node);
    };
  }
</script>

<li
  class="tile"
  class:speaking
  class:screen
  class:featured
  class:revealed
  class:video-on={videoOn}
  onpointerup={reveal}
  oncontextmenu={openVolume}
>
  {#if videoOn && localVideo && !screen}
    <div class="video" {@attach nativeVideoSlot(localVideo)}></div>
  {:else if videoOn}
    <video
      class="video"
      class:mirrored={participant.local && !screen}
      autoplay
      muted
      playsinline
      {@attach attachVideo}
    ></video>
  {:else}
    <div class="placeholder">
      <Avatar src={avatar} {name} id={userId} size="large" />
    </div>
  {/if}

  <div class="actions">
    {#if onPin}
      <IconButton
        variant="ghost"
        size="small"
        class="tile-action"
        label={$i18n.t(pinned ? 'call.unpin' : 'call.pin', { name: label })}
        aria-pressed={pinned}
        onclick={onPin}
      >
        {#if pinned}
          <PushPinSlashIcon />
        {:else}
          <PushPinIcon />
        {/if}
      </IconButton>
    {/if}
    {#if !participant.local && !screen}
      <IconButton
        variant="ghost"
        size="small"
        class="tile-action"
        label={$i18n.t('call.participantVolume', { name })}
        aria-expanded={volumeOpen}
        data-volume-toggle
        onclick={() => (volumeOpen = !volumeOpen)}
      >
        {#if volume === 0}
          <SpeakerSlashIcon />
        {:else}
          <SpeakerHighIcon />
        {/if}
      </IconButton>
    {/if}
  </div>

  <div class="tag">
    {#if screen}
      <MonitorIcon aria-hidden="true" weight="fill" />
    {:else if muted}
      <span class="muted" title={$i18n.t('call.muted')}>
        <MicrophoneSlashIcon aria-hidden="true" weight="fill" />
        <span class="screen-reader-only">{$i18n.t('call.muted')}</span>
      </span>
    {/if}
    <span class="name">{label}</span>
    {#if quality === 'poor'}
      <span class="quality" title={$i18n.t('call.connectionPoor')}>
        <CellSignalLowIcon aria-hidden="true" weight="fill" />
        <span class="screen-reader-only">{$i18n.t('call.connectionPoor')}</span>
      </span>
    {:else if quality === 'lost'}
      <span class="quality lost" title={$i18n.t('call.connectionLost')}>
        <CellSignalSlashIcon aria-hidden="true" weight="fill" />
        <span class="screen-reader-only">{$i18n.t('call.connectionLost')}</span>
      </span>
    {/if}
  </div>

  {#if volumeOpen}
    <div class="volume" {@attach dismissVolume}>
      <Slider
        min={0}
        max={MAX_PARTICIPANT_VOLUME}
        step={0.05}
        label={$i18n.t('call.participantVolume', { name })}
        value={volume}
        oninput={applyVolume}
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
    --tile-scrim: color-mix(in srgb, var(--picker-black) 62%, transparent);

    background: var(--surface-var-container);
    border-radius: var(--radii-400);
    box-sizing: border-box;
    container-type: size;
    overflow: hidden;
    position: relative;
  }

  .tile::after {
    border-radius: inherit;
    box-shadow: inset 0 0 0 0 var(--success-main);
    content: '';
    inset: 0;
    pointer-events: none;
    position: absolute;
    transition: box-shadow var(--motion-normal) var(--motion-easing-emphasized);
  }

  .tile.speaking.video-on::after {
    box-shadow:
      inset 0 0 0 0.1875rem var(--success-main),
      inset 0 0 0 0.3125rem color-mix(in srgb, var(--success-main) 30%, transparent);
  }

  .tile.screen,
  .tile.video-on {
    background: var(--picker-black);
  }

  .video {
    block-size: 100%;
    display: block;
    inline-size: 100%;
    object-fit: cover;
  }

  .screen .video {
    object-fit: contain;
  }

  .video.mirrored {
    transform: scaleX(-1);
  }

  .placeholder {
    align-items: center;
    block-size: 100%;
    display: flex;
    inline-size: 100%;
    justify-content: center;
  }

  .placeholder :global(.avatar-root) {
    --avatar-size: clamp(2.5rem, 36cqmin, 6rem);

    transition: box-shadow var(--motion-normal) var(--motion-easing-emphasized);
  }

  .featured .placeholder :global(.avatar-root) {
    --avatar-size: clamp(3rem, 30cqmin, 9rem);
  }

  .speaking:not(.video-on) .placeholder :global(.avatar-root) {
    box-shadow:
      0 0 0 0.1875rem var(--surface-var-container),
      0 0 0 0.375rem var(--success-main);
  }

  .tag {
    align-items: center;
    backdrop-filter: blur(0.5rem);
    background: var(--tile-scrim);
    border-radius: var(--radii-300);
    box-sizing: border-box;
    color: var(--picker-white);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: var(--space-100);
    inset: auto auto var(--space-200) var(--space-200);
    max-inline-size: calc(100% - var(--space-400));
    padding: var(--space-050) var(--space-200);
    position: absolute;
  }

  .tag :global(svg) {
    flex: none;
    height: 0.875rem;
    width: 0.875rem;
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .muted {
    color: var(--crit-main);
    display: inline-flex;
    flex: none;
  }

  .quality {
    color: var(--warn-main);
    display: inline-flex;
    flex: none;
  }

  .quality.lost {
    color: var(--crit-main);
  }

  .actions {
    display: flex;
    gap: var(--space-100);
    inset: var(--space-200) var(--space-200) auto auto;
    opacity: 0;
    pointer-events: none;
    position: absolute;
    transition: opacity var(--motion-normal) var(--motion-easing-emphasized);
  }

  .actions:focus-within,
  .revealed .actions,
  .actions:has(:global([aria-pressed='true'], [aria-expanded='true'])) {
    opacity: 1;
    pointer-events: auto;
  }

  @media (hover: hover) {
    .tile:hover .actions {
      opacity: 1;
      pointer-events: auto;
    }
  }

  @media (pointer: coarse) {
    .actions :global(.tile-action) {
      --button-height: var(--target-hit);
    }
  }

  .actions :global(.tile-action) {
    --button-container: var(--tile-scrim);
    --button-container-hover: color-mix(in srgb, var(--picker-black) 80%, transparent);
    --button-container-active: var(--picker-black);

    backdrop-filter: blur(0.5rem);
    color: var(--picker-white);
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
    inset: calc(var(--space-200) + var(--control-height-300) + var(--space-100)) var(--space-200)
      auto auto;
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
</style>
