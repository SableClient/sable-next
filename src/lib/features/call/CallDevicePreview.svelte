<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import VideoCameraSlashIcon from 'phosphor-svelte/lib/VideoCameraSlashIcon';
  import type { Snippet } from 'svelte';

  import type { MemberIdentity } from '#lib/features/room/members.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import CallDeviceMenu from './CallDeviceMenu.svelte';
  import { DEVICE_PREFERENCE } from './devices';
  import type { CallMedia } from './call-session.svelte.js';
  import { startInputMeter } from './input-meter';

  interface Props {
    media: CallMedia;
    onChange: (media: CallMedia) => void;
    surface?: string;
    self?: MemberIdentity | null;
  }

  let { media, onChange, surface, self = null }: Props = $props();

  let micLabel = $derived(
    media.microphone ? $i18n.t('call.microphoneOn') : $i18n.t('call.microphoneOff')
  );
  let cameraLabel = $derived(media.camera ? $i18n.t('call.cameraOn') : $i18n.t('call.cameraOff'));

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
  <div class="preview">
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

    <div class="toggles">
      <div class="group" class:muted={!media.microphone}>
        {#snippet micButton(props: Record<string, unknown>)}
          <IconButton
            {...props}
            variant="ghost"
            class={['toggle', !media.microphone && 'off']}
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
        <CallDeviceMenu
          kinds={['audioinput']}
          label={$i18n.t('call.microphoneDevices')}
          {surface}
          onSelect={selectDevice}
        />
      </div>
      <div class="group">
        {#snippet cameraButton(props: Record<string, unknown>)}
          <IconButton
            {...props}
            variant="ghost"
            class={['toggle', media.camera && 'on']}
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
        <CallDeviceMenu
          kinds={['videoinput']}
          label={$i18n.t('call.cameraDevices')}
          {surface}
          onSelect={selectDevice}
        />
      </div>
      <div class="group">
        <CallDeviceMenu
          kinds={['audiooutput']}
          label={$i18n.t('call.outputDevices')}
          {surface}
          speaker
          onSelect={selectDevice}
        />
      </div>
    </div>
  </div>

  <div class="meter">
    {#if media.microphone}
      {#if testing && meterReady}
        <MicrophoneIcon aria-hidden="true" weight="fill" />
        <span class="track" aria-hidden="true">
          <span class="fill" style:scale="{level} 1"></span>
        </span>
      {/if}
      <Button variant="ghost" onclick={() => (testing = !testing)}>
        {testing ? $i18n.t('call.stopMicTest') : $i18n.t('call.testMic')}
      </Button>
    {:else}
      <p class="hint">{$i18n.t('call.testMicNeedsMic')}</p>
    {/if}
  </div>
</div>

<style>
  .prescreen {
    display: grid;
    gap: var(--space-200);
    padding: var(--space-300);
  }

  .preview {
    align-items: center;
    aspect-ratio: 16 / 9;
    background: var(--call-tile-bg, var(--surface-var-container));
    border-radius: var(--radii-500);
    container-type: size;
    display: flex;
    justify-content: center;
    overflow: hidden;
    position: relative;
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
    padding-block-end: var(--space-800);
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

  .toggles {
    display: flex;
    gap: var(--space-200);
    inset: auto 0 var(--space-300);
    justify-content: center;
    position: absolute;
  }

  .group {
    align-items: center;
    backdrop-filter: blur(0.75rem);
    background: color-mix(in srgb, var(--bg-container) 86%, transparent);
    border-radius: var(--radii-pill);
    display: flex;
    padding: var(--space-050);
  }

  .group.muted {
    background: color-mix(in srgb, var(--crit-container) 92%, transparent);
  }

  .group.muted :global(.device-caret) {
    --button-on-container: var(--crit-on-container);
  }

  .group :global(.device-speaker) {
    --button-container: var(--surface-var-container);
    --button-container-hover: var(--surface-var-container-hover);
    --button-container-active: var(--surface-var-container-active);
    --button-line: transparent;
    --button-on-container: var(--surface-var-on-container);
    --button-gap: var(--space-100);
    --button-padding-inline: var(--space-300);

    border-radius: var(--radii-pill);
  }

  .group :global(.toggle) {
    --button-container: var(--surface-var-container);
    --button-container-hover: var(--surface-var-container-hover);
    --button-container-active: var(--surface-var-container-active);
    --button-line: transparent;
    --button-on-container: var(--surface-var-on-container);

    border-radius: var(--radii-pill);
  }

  .group :global(.toggle.off) {
    --button-container: var(--crit-container);
    --button-container-hover: var(--crit-container-hover);
    --button-container-active: var(--crit-container-active);
    --button-on-container: var(--crit-on-container);
  }

  .group :global(.toggle.on) {
    --button-container: var(--call-on-container, var(--primary-container));
    --button-container-hover: var(--call-on-container-hover, var(--primary-container-hover));
    --button-container-active: var(--call-on-container-hover, var(--primary-container-active));
    --button-on-container: var(--call-on-ink, var(--primary-on-container));
  }

  .group :global(.device-caret) {
    --button-container: transparent;
    --button-container-hover: var(--surface-var-container-hover);
    --button-on-container: var(--bg-on-container);

    border-radius: var(--radii-pill);
    width: 1.5rem;
  }

  .meter {
    align-items: center;
    color: var(--success-main);
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
    min-block-size: var(--control-height-300);
    padding-inline: var(--space-100);
  }

  .meter :global(svg) {
    flex: none;
    height: var(--size-x200);
    width: var(--size-x200);
  }

  .track {
    background: var(--surface-var-container);
    block-size: 0.375rem;
    border-radius: var(--radii-pill);
    flex: 1;
    overflow: hidden;
  }

  .fill {
    background: var(--success-main);
    block-size: 100%;
    display: block;
    transform-origin: left center;
    transition: scale var(--duration-micro) linear;
  }

  .hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }
</style>
