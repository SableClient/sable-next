<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import VideoCameraSlashIcon from 'phosphor-svelte/lib/VideoCameraSlashIcon';
  import GearSixIcon from 'phosphor-svelte/lib/GearSixIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import type { Snippet } from 'svelte';

  import type { MemberIdentity } from '#lib/features/room/members.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import CallDeviceMenu from './CallDeviceMenu.svelte';
  import { DEVICE_PREFERENCE, supportsDeviceSelection } from './devices';
  import type { CallMedia } from './call-session.svelte.js';
  import { startInputMeter } from './input-meter';

  interface Props {
    media: CallMedia;
    onChange: (media: CallMedia) => void;
    self?: MemberIdentity | null;
    onOpenSettings?: (event: MouseEvent) => void;
  }

  let { media, onChange, self = null, onOpenSettings }: Props = $props();

  let micLabel = $derived(
    media.microphone ? $i18n.t('call.microphoneOn') : $i18n.t('call.microphoneOff')
  );
  let cameraLabel = $derived(media.camera ? $i18n.t('call.cameraOn') : $i18n.t('call.cameraOff'));

  const selectable = supportsDeviceSelection();
  let speakerOpen = $state(false);

  function selectDevice(kind: MediaDeviceKind, deviceId: string): void {
    setPreference(DEVICE_PREFERENCE[kind], deviceId);
  }

  let stream = $state.raw<MediaStream | undefined>(undefined);
  let cameraFailed = $state(false);
  let wantsCamera = $derived(media.camera);
  let cameraDevice = $derived(preferences.videoInputDevice);

  $effect(() => {
    if (!wantsCamera) {
      stream = undefined;
      cameraFailed = false;
      return;
    }

    let cancelled = false;
    let opened: MediaStream | undefined;
    const deviceId = cameraDevice;

    navigator.mediaDevices
      .getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true })
      .then((next) => {
        if (cancelled) {
          for (const track of next.getTracks()) track.stop();
          return;
        }
        opened = next;
        stream = next;
        cameraFailed = false;
      })
      .catch(() => {
        if (cancelled) return;
        stream = undefined;
        cameraFailed = true;
      });

    return () => {
      cancelled = true;
      for (const track of opened?.getTracks() ?? []) track.stop();
    };
  });

  let level = $state(0);
  let meterReady = $state(false);
  let testing = $state(false);
  let wantsMicrophone = $derived(media.microphone && testing);
  let microphoneDevice = $derived(preferences.audioInputDevice);

  $effect(() => {
    level = 0;
    meterReady = false;
    if (!wantsMicrophone || typeof navigator === 'undefined' || !navigator.mediaDevices) return;

    let cancelled = false;
    let stop: (() => void) | null = null;
    void startInputMeter(microphoneDevice, (next) => (level = next)).then((dispose) => {
      if (cancelled) {
        dispose?.();
        return;
      }
      stop = dispose;
      meterReady = dispose !== null;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  });

  function attachPreview(node: HTMLVideoElement) {
    node.srcObject = stream ?? null;
    return () => {
      node.srcObject = null;
    };
  }
</script>

{#snippet tip(label: string, button: Snippet<[Record<string, unknown>]>)}
  <Tooltip {label}>
    {#snippet trigger({ props })}{@render button(props)}{/snippet}
  </Tooltip>
{/snippet}

<div class="prescreen">
  <div class="tile" class:video-on={wantsCamera && stream}>
    {#if wantsCamera && stream}
      <video
        class="video"
        autoplay
        muted
        playsinline
        aria-label={$i18n.t('call.prescreenPreview')}
        {@attach attachPreview}
      ></video>
    {:else}
      <div class="camera-off">
        {#if self}
          <Avatar src={self.avatar} name={self.name} id={self.userId} size="large" />
        {/if}
        <p>
          {cameraFailed ? $i18n.t('call.cameraUnavailable') : $i18n.t('call.prescreenNoCamera')}
        </p>
      </div>
    {/if}
    {#if self}
      <span class="tag">
        {#if !media.microphone}<MicrophoneSlashIcon aria-hidden="true" weight="fill" />{/if}
        <span class="name">{self.name}</span>
      </span>
    {/if}
    {#if testing && meterReady}
      <span class="level" aria-hidden="true">
        <span class="fill" style:scale="{level} 1"></span>
      </span>
    {/if}
  </div>

  <div class="tray">
    <div class="group" data-tone={media.microphone ? 'neutral' : 'danger'}>
      {#snippet micButton(props: Record<string, unknown>)}
        <IconButton
          {...props}
          variant="ghost"
          label={micLabel}
          onclick={() => onChange({ ...media, microphone: !media.microphone })}
        >
          {#if media.microphone}
            <MicrophoneIcon />
          {:else}
            <MicrophoneSlashIcon weight="fill" />
          {/if}
        </IconButton>
      {/snippet}
      {@render tip(micLabel, micButton)}
      {#if selectable}<span class="divider" aria-hidden="true"></span>{/if}
      <CallDeviceMenu
        kinds={['audioinput']}
        label={$i18n.t('call.microphoneDevices')}
        onSelect={selectDevice}
      />
    </div>
    <div class="group" data-tone={media.camera ? 'primary' : 'neutral'}>
      {#snippet cameraButton(props: Record<string, unknown>)}
        <IconButton
          {...props}
          variant="ghost"
          label={cameraLabel}
          onclick={() => onChange({ ...media, camera: !media.camera })}
        >
          {#if media.camera}
            <VideoCameraIcon weight="fill" />
          {:else}
            <VideoCameraSlashIcon />
          {/if}
        </IconButton>
      {/snippet}
      {@render tip(cameraLabel, cameraButton)}
      {#if selectable}<span class="divider" aria-hidden="true"></span>{/if}
      <CallDeviceMenu
        kinds={['videoinput']}
        label={$i18n.t('call.cameraDevices')}
        onSelect={selectDevice}
      />
    </div>
    {#if selectable}
      <div class="group" data-tone="neutral">
        {#snippet speakerButton(props: Record<string, unknown>)}
          <IconButton
            {...props}
            variant="ghost"
            label={$i18n.t('call.outputDevices')}
            onclick={() => (speakerOpen = true)}
          >
            <SpeakerHighIcon />
          </IconButton>
        {/snippet}
        {@render tip($i18n.t('call.outputDevices'), speakerButton)}
        <span class="divider" aria-hidden="true"></span>
        <CallDeviceMenu
          bind:open={speakerOpen}
          kinds={['audiooutput']}
          label={$i18n.t('call.outputDevices')}
          onSelect={selectDevice}
        />
      </div>
    {/if}

    <div class="tray-end">
      {#snippet testButton(props: Record<string, unknown>)}
        <Button
          {...props}
          variant="secondary"
          aria-disabled={media.microphone ? undefined : 'true'}
          aria-pressed={testing}
          onclick={() => {
            if (media.microphone) testing = !testing;
          }}
        >
          {testing && media.microphone ? $i18n.t('call.stopMicTest') : $i18n.t('call.testMic')}
        </Button>
      {/snippet}
      {#if media.microphone}
        {@render testButton({})}
      {:else}
        {@render tip($i18n.t('call.testMicNeedsMic'), testButton)}
      {/if}
      {#if onOpenSettings}
        {#snippet settingsButton(props: Record<string, unknown>)}
          <IconButton
            {...props}
            variant="secondary"
            label={$i18n.t('call.settings')}
            onclick={onOpenSettings}
          >
            <GearSixIcon />
          </IconButton>
        {/snippet}
        {@render tip($i18n.t('call.settings'), settingsButton)}
      {/if}
    </div>
  </div>
</div>

<style>
  .prescreen {
    display: grid;
    gap: var(--space-300);
    padding: var(--space-300);
  }

  .tile {
    align-items: center;
    aspect-ratio: 16 / 9;
    background: var(--surface-var-container);
    border-radius: var(--radii-500);
    container-type: size;
    display: flex;
    justify-content: center;
    overflow: hidden;
    position: relative;
  }

  .tile.video-on {
    background: var(--picker-black);
  }

  .video {
    block-size: 100%;
    inline-size: 100%;
    object-fit: cover;
    transform: scaleX(-1);
  }

  .camera-off {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
  }

  .camera-off :global(.avatar-root) {
    --avatar-size: clamp(3rem, 30cqmin, 6rem);
  }

  .camera-off p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    text-align: center;
  }

  .tag {
    align-items: center;
    backdrop-filter: blur(0.5rem);
    background: color-mix(in srgb, var(--picker-black) 62%, transparent);
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
    color: var(--crit-main);
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

  .level {
    background: color-mix(in srgb, var(--bg-container) 70%, transparent);
    block-size: var(--space-100);
    border-radius: var(--radii-pill);
    inset: var(--space-200) var(--space-300) auto;
    overflow: hidden;
    position: absolute;
  }

  .fill {
    background: var(--success-main);
    block-size: 100%;
    display: block;
    transform-origin: left center;
    transition: scale var(--duration-micro) linear;
  }

  .tray {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .group {
    --radius-outer: var(--radii-400);
    --radius-padding: var(--space-050);
    --radius-inner: max(0px, calc(var(--radius-outer) - var(--radius-padding)));
    --tone: var(--sec-container);
    --tone-line: var(--sec-container-line);
    --ghost-hover: var(--sec-container-hover);
    --ghost-active: var(--sec-container-active);

    align-items: center;
    background: var(--tone);
    border: var(--border-width) solid var(--tone-line);
    border-radius: var(--radius-outer);
    color: var(--sec-on-container);
    display: flex;
    padding: var(--radius-padding);
  }

  .group[data-tone='danger'] {
    --tone: var(--crit-container);
    --tone-line: var(--crit-container-line);
    --ghost-hover: var(--crit-container-hover);
    --ghost-active: var(--crit-container-active);

    color: var(--crit-on-container);
  }

  .group[data-tone='primary'] {
    --tone: var(--primary-main);
    --tone-line: var(--primary-main-line);
    --ghost-hover: var(--primary-main-hover);
    --ghost-active: var(--primary-main-active);

    color: var(--primary-on-main);
  }

  .group :global(.btn) {
    --button-height: var(--control-height-300);
  }

  .divider {
    align-self: stretch;
    background: var(--tone-line);
    flex: none;
    inline-size: var(--border-width);
    margin: var(--space-100) var(--space-050);
  }

  .tray-end {
    --button-height: calc(
      var(--control-height-300) + var(--space-050) * 2 + var(--border-width) * 2
    );

    display: flex;
    gap: var(--space-200);
    margin-inline-start: auto;
  }

  .tray-end :global(.btn[aria-disabled='true']) {
    pointer-events: auto;
  }
</style>
