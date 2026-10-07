<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import CornersInIcon from 'phosphor-svelte/lib/CornersInIcon';
  import CornersOutIcon from 'phosphor-svelte/lib/CornersOutIcon';
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
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';

  import { cameraVisible, type CallTileSource } from './call-layout';
  import type {
    CallParticipant,
    CallRemoteVideoOverlay,
    CallVideoOverlay,
    CallVideoRect,
  } from './call-transport';
  import { nativeVideoSlot } from './native-video-overlay';
  import {
    MAX_PARTICIPANT_VOLUME,
    participantVolume,
    screenVolumeKey,
    setParticipantVolume,
  } from './participant-volumes.svelte.js';

  interface Props {
    participant: CallParticipant;
    source: CallTileSource;
    room: LivekitRoom | undefined;
    localVideo?: CallVideoOverlay;
    remoteVideo?: CallRemoteVideoOverlay;
    name: string;
    userId: string;
    avatar: string | null;
    pinned?: boolean;
    featured?: boolean;
    onPin?: () => void;
    watchingScreen?: boolean;
    onWatchScreen?: () => void;
    onVolumeChange?: (identity: string, volume: number) => void;
  }

  let {
    participant,
    source,
    room,
    localVideo,
    remoteVideo,
    name,
    userId,
    avatar,
    pinned = false,
    featured = false,
    onPin,
    watchingScreen = false,
    onWatchScreen,
    onVolumeChange,
  }: Props = $props();

  function applyVolume(next: number): void {
    setParticipantVolume(volumeKey, next);
    if (!screen) onVolumeChange?.(participant.identity, next);
  }

  let screen = $derived(source === 'screen');
  let volumeKey = $derived(screen ? screenVolumeKey(userId) : userId);
  let adjustable = $derived(
    !participant.local &&
      (!screen || (watchingScreen && participant.screenShareAudio !== undefined))
  );
  let volumeLabel = $derived(
    screen ? $i18n.t('call.screenVolume', { name }) : $i18n.t('call.participantVolume', { name })
  );
  let videoOn = $derived(
    screen ? participant.local === true || watchingScreen : cameraVisible(participant)
  );
  let videoTrackId = $derived.by(() => {
    const published = screen ? participant.screenShare : participant.camera;
    return published?.subscribed || participant.local ? published?.id : undefined;
  });
  let muted = $derived(participant.microphone === undefined || participant.microphone.muted);
  let speaking = $derived(!screen && !muted && participant.speaking === true);
  let quality = $derived(participant.connectionQuality ?? 'unknown');
  let label = $derived(screen ? $i18n.t('call.screenOf', { name }) : name);
  let volume = $derived(participantVolume(volumeKey));
  let volumeOpen = $state(false);
  let revealed = $state(false);
  let element = $state<HTMLLIElement>();
  let fullscreen = $state(false);
  const fullscreenAvailable =
    typeof document !== 'undefined' &&
    document.fullscreenEnabled &&
    typeof HTMLElement.prototype.requestFullscreen === 'function';

  function toggleFullscreen(): void {
    if (fullscreen) void document.exitFullscreen();
    else void element?.requestFullscreen();
  }

  function reveal(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    if (event.target instanceof Element && event.target.closest('button, input')) return;
    revealed = !revealed;
  }

  function openVolume(event: MouseEvent): void {
    if (!adjustable) return;
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

  let remoteSlot = $derived.by(() => {
    const trackId = participant.screenShare?.id;
    if (!remoteVideo || !screen || trackId === undefined) return undefined;
    const identity = participant.identity;
    return {
      place: (rect: CallVideoRect) => remoteVideo.place({ ...rect, identity, trackId }),
      clear: () => remoteVideo.clear(),
    };
  });

  function attachVideo(node: HTMLVideoElement) {
    if (videoTrackId === undefined) return;
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
  class:audible={screen && adjustable}
  class:video-on={videoOn}
  class:overlaid={videoOn && remoteSlot !== undefined}
  bind:this={element}
  onfullscreenchange={() => (fullscreen = document.fullscreenElement === element)}
  onpointerup={reveal}
  oncontextmenu={openVolume}
>
  {#if videoOn && localVideo && !screen}
    <div class="video" {@attach nativeVideoSlot(localVideo)}></div>
  {:else if videoOn && remoteSlot}
    <div class="video" {@attach nativeVideoSlot(remoteSlot)}></div>
  {:else if videoOn}
    <video
      class="video"
      class:mirrored={participant.local && !screen}
      autoplay
      muted
      playsinline
      {@attach attachVideo}
    ></video>
  {:else if screen}
    <div class="share-placeholder">
      <MonitorIcon aria-hidden="true" />
      <p class="name" title={label}>{label}</p>
      {#if onWatchScreen}
        <Button
          variant="primary"
          size="small"
          aria-label={$i18n.t('call.watchScreen', { name })}
          onclick={onWatchScreen}
        >
          {$i18n.t('call.watch')}
        </Button>
      {/if}
    </div>
  {:else}
    <div class="placeholder">
      <Avatar src={avatar} {name} id={userId} size="large" />
    </div>
  {/if}

  {#if screen && videoOn && onWatchScreen}
    <div class="stop-watching">
      <Button
        variant="ghost"
        size="small"
        class="tile-action"
        aria-label={$i18n.t('call.stopWatchingScreen', { name })}
        onclick={onWatchScreen}
      >
        {$i18n.t('call.stopWatching')}
      </Button>
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
    {#if screen && videoOn && fullscreenAvailable}
      <IconButton
        variant="ghost"
        size="small"
        class="tile-action"
        label={$i18n.t(fullscreen ? 'call.exitFullscreen' : 'call.fullscreen')}
        onclick={toggleFullscreen}
      >
        {#if fullscreen}
          <CornersInIcon />
        {:else}
          <CornersOutIcon />
        {/if}
      </IconButton>
    {/if}
    {#if adjustable}
      <IconButton
        variant="ghost"
        size="small"
        class="tile-action"
        label={volumeLabel}
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

  {#if !screen || videoOn}
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
  {/if}

  {#if volumeOpen && adjustable}
    <div class="volume" {@attach dismissVolume}>
      <Slider
        min={0}
        max={MAX_PARTICIPANT_VOLUME}
        step={0.05}
        label={volumeLabel}
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
    color: var(--surface-var-on-container);
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

  .tile.video-on {
    background: var(--picker-black);
  }

  .tile:fullscreen {
    border-radius: 0;
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

  .share-placeholder {
    align-items: center;
    block-size: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    justify-content: center;
    padding: var(--space-200);
  }

  .share-placeholder :global(svg) {
    block-size: var(--size-x500);
    flex: none;
    inline-size: var(--size-x500);
  }

  @container (height < 9rem) {
    .share-placeholder :global(svg) {
      display: none;
    }
  }

  .stop-watching {
    inset: var(--space-200) auto auto var(--space-200);
    position: absolute;
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

  .share-placeholder .name {
    font-size: var(--font-size-small);
    margin: 0;
    max-inline-size: 100%;
  }

  .overlaid {
    display: flex;
    flex-direction: column;
  }

  .overlaid .video {
    block-size: auto;
    flex: 1;
    min-block-size: 0;
    order: 1;
  }

  .overlaid .stop-watching {
    min-block-size: calc(var(--control-height-300) + var(--space-200));
    padding: var(--space-100) var(--space-200);
    position: static;
  }

  .overlaid .tag {
    display: none;
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
  .audible .actions,
  .actions:has(:global([aria-pressed='true'], [aria-expanded='true'])) {
    opacity: 1;
    pointer-events: auto;
  }

  @media (any-hover: hover) {
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

  .actions :global(.tile-action),
  .stop-watching :global(.tile-action) {
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
    color: var(--bg-on-container);
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
