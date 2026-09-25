<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import VideoCameraSlashIcon from 'phosphor-svelte/lib/VideoCameraSlashIcon';
  import CameraRotateIcon from 'phosphor-svelte/lib/CameraRotateIcon';
  import MonitorArrowUpIcon from 'phosphor-svelte/lib/MonitorArrowUpIcon';
  import HeadphonesIcon from 'phosphor-svelte/lib/HeadphonesIcon';
  import SpeakerHighIcon from 'phosphor-svelte/lib/SpeakerHighIcon';
  import SpeakerSlashIcon from 'phosphor-svelte/lib/SpeakerSlashIcon';
  import PhoneDisconnectIcon from 'phosphor-svelte/lib/PhoneDisconnectIcon';
  import GearSixIcon from 'phosphor-svelte/lib/GearSixIcon';
  import type { Snippet } from 'svelte';

  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { formatBinding } from '#lib/ui/shortcuts/binding.js';
  import { effectiveShortcuts } from '#lib/ui/shortcuts/bindings.svelte.js';
  import { isMacPlatform } from '#lib/ui/shortcuts/global-shortcuts.js';
  import type { ShortcutId } from '#lib/ui/shortcuts/shortcuts.js';

  import { longPress } from '#lib/ui/long-press.svelte.js';

  import CallDeviceMenu from './CallDeviceMenu.svelte';
  import { supportsDeviceSelection } from './devices';

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
    onToggleDeafen?: () => void;
    onHangUp?: () => void;
    onSwitchDevice?: (kind: MediaDeviceKind, deviceId: string) => void;
    onSwitchCamera?: () => void;
    onOpenSettings?: (event: MouseEvent) => void;
    extra?: Snippet;
    action?: Snippet;
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
    onSwitchDevice,
    onSwitchCamera,
    onOpenSettings,
    extra,
    action,
  }: Props = $props();

  let size = $derived<'small' | 'medium'>(compact ? 'small' : 'medium');
  let neutral = $derived<'ghost' | 'secondary'>(compact ? 'ghost' : 'secondary');
  let devices = $derived(compact ? undefined : onSwitchDevice);
  const selectable = supportsDeviceSelection();
  let grouped = $derived(devices !== undefined && selectable);
  let pending = $derived(ready ? '' : ` · ${$i18n.t('call.waitingForMedia')}`);
  let micMenu = $state(false);
  let outputMenu = $state(false);
  let cameraMenu = $state(false);

  function shortcut(id: ShortcutId): string {
    const binding = effectiveShortcuts().find((item) => item.id === id)?.binding;
    return binding ? ` (${formatBinding(binding, isMacPlatform())})` : '';
  }

  let micLabel = $derived($i18n.t(microphoneEnabled ? 'call.microphoneOn' : 'call.microphoneOff'));
  let cameraLabel = $derived($i18n.t(cameraEnabled ? 'call.cameraOn' : 'call.cameraOff'));
  let screenLabel = $derived(
    $i18n.t(screenShareEnabled ? 'call.screenShareOn' : 'call.screenShareOff')
  );
  let deafenLabel = $derived($i18n.t(deafened ? 'call.undeafen' : 'call.deafen'));
</script>

{#snippet control(
  tip: string,
  button: Snippet<[Record<string, unknown>]>,
  menu?: Snippet,
  onHold?: () => void,
  tone?: 'neutral' | 'danger' | 'primary'
)}
  <div
    class={['control', grouped && menu && 'group']}
    data-tone={grouped && menu ? tone : undefined}
    {@attach longPress({ enabled: () => onHold !== undefined, onPress: () => onHold?.() })}
  >
    <Tooltip label={tip}>
      {#snippet trigger({ props })}{@render button(props)}{/snippet}
    </Tooltip>
    {#if grouped && menu}<span class="divider" aria-hidden="true"></span>{/if}
    {@render menu?.()}
  </div>
{/snippet}

<div class="controls" class:compact>
  {#snippet micButton(props: Record<string, unknown>)}
    <IconButton
      {...props}
      variant={grouped ? 'ghost' : microphoneEnabled ? neutral : 'danger'}
      {size}
      label={micLabel}
      aria-disabled={ready ? undefined : 'true'}
      onclick={ready ? onToggleMicrophone : undefined}
    >
      {#if microphoneEnabled}
        <MicrophoneIcon />
      {:else}
        <MicrophoneSlashIcon weight="fill" />
      {/if}
    </IconButton>
  {/snippet}
  {#snippet micMenuSnippet()}
    {#if devices}
      <CallDeviceMenu
        bind:open={micMenu}
        kinds={['audioinput']}
        label={$i18n.t('call.microphoneDevices')}
        onSelect={devices}
      />
    {/if}
  {/snippet}
  {@render control(
    `${micLabel}${shortcut('call.toggleMute')}${pending}`,
    micButton,
    micMenuSnippet,
    devices ? () => (micMenu = true) : undefined,
    microphoneEnabled ? 'neutral' : 'danger'
  )}

  {#snippet deafenButton(props: Record<string, unknown>)}
    {#if onToggleDeafen}
      <IconButton
        {...props}
        variant={grouped ? 'ghost' : deafened ? 'danger' : neutral}
        {size}
        label={deafenLabel}
        onclick={onToggleDeafen}
      >
        {#if deafened}
          <SpeakerSlashIcon weight="fill" />
        {:else}
          <HeadphonesIcon />
        {/if}
      </IconButton>
    {:else}
      <IconButton
        {...props}
        variant={grouped ? 'ghost' : neutral}
        {size}
        label={$i18n.t('call.outputDevices')}
        onclick={() => (outputMenu = true)}
      >
        <SpeakerHighIcon />
      </IconButton>
    {/if}
  {/snippet}
  {#snippet deafenMenu()}
    {#if devices}
      <CallDeviceMenu
        bind:open={outputMenu}
        kinds={['audiooutput']}
        label={$i18n.t('call.outputDevices')}
        onSelect={devices}
      />
    {/if}
  {/snippet}
  {@render control(
    onToggleDeafen
      ? `${deafenLabel}${shortcut('call.toggleDeafen')}`
      : $i18n.t('call.outputDevices'),
    deafenButton,
    deafenMenu,
    devices ? () => (outputMenu = true) : undefined,
    deafened ? 'danger' : 'neutral'
  )}

  {#snippet cameraButton(props: Record<string, unknown>)}
    <IconButton
      {...props}
      variant={grouped ? 'ghost' : cameraEnabled ? 'primary' : neutral}
      {size}
      label={cameraLabel}
      aria-disabled={ready ? undefined : 'true'}
      onclick={ready ? onToggleCamera : undefined}
    >
      {#if cameraEnabled}
        <VideoCameraIcon weight="fill" />
      {:else}
        <VideoCameraSlashIcon />
      {/if}
    </IconButton>
  {/snippet}
  {#snippet cameraMenuSnippet()}
    {#if devices}
      <CallDeviceMenu
        bind:open={cameraMenu}
        kinds={['videoinput']}
        label={$i18n.t('call.cameraDevices')}
        onSelect={devices}
      />
    {/if}
  {/snippet}
  {@render control(
    `${cameraLabel}${shortcut('call.toggleCamera')}${pending}`,
    cameraButton,
    cameraMenuSnippet,
    devices ? () => (cameraMenu = true) : undefined,
    cameraEnabled ? 'primary' : 'neutral'
  )}

  {#if onSwitchCamera && !compact}
    {#snippet switchCameraButton(props: Record<string, unknown>)}
      <IconButton
        {...props}
        variant={neutral}
        {size}
        label={$i18n.t('call.switchCamera')}
        disabled={!cameraEnabled}
        aria-disabled={ready ? undefined : 'true'}
        onclick={ready ? onSwitchCamera : undefined}
      >
        <CameraRotateIcon />
      </IconButton>
    {/snippet}
    {@render control($i18n.t('call.switchCamera'), switchCameraButton)}
  {/if}

  {#if canScreenShare}
    {#snippet screenButton(props: Record<string, unknown>)}
      <IconButton
        {...props}
        variant={screenShareEnabled ? 'primary' : neutral}
        {size}
        label={screenLabel}
        aria-disabled={ready ? undefined : 'true'}
        onclick={ready ? onToggleScreenShare : undefined}
      >
        <MonitorArrowUpIcon weight={screenShareEnabled ? 'fill' : 'regular'} />
      </IconButton>
    {/snippet}
    {@render control(`${screenLabel}${shortcut('call.toggleScreenShare')}${pending}`, screenButton)}
  {/if}

  {#if extra}
    <div class="control">{@render extra()}</div>
  {/if}

  {#if onOpenSettings}
    {#snippet settingsButton(props: Record<string, unknown>)}
      <IconButton
        {...props}
        variant={neutral}
        {size}
        label={$i18n.t('call.settings')}
        onclick={onOpenSettings}
      >
        <GearSixIcon />
      </IconButton>
    {/snippet}
    {@render control($i18n.t('call.settings'), settingsButton)}
  {/if}

  {#snippet hangUpButton(props: Record<string, unknown>)}
    <IconButton
      {...props}
      class="hang-up"
      variant="danger"
      {size}
      label={$i18n.t('call.hangUp')}
      onclick={onHangUp}
    >
      <PhoneDisconnectIcon weight="fill" />
    </IconButton>
  {/snippet}
  {#if action}
    <div class="control action">{@render action()}</div>
  {:else if onHangUp}
    {@render control(`${$i18n.t('call.hangUp')}${shortcut('call.hangUp')}`, hangUpButton)}
  {/if}
</div>

<style>
  .controls {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: center;
  }

  .controls:not(.compact) {
    --radius-outer: var(--radii-500);
    --radius-padding: var(--space-150);
    --radius-inner: max(0px, calc(var(--radius-outer) - var(--radius-padding)));

    backdrop-filter: blur(0.75rem);
    background: color-mix(in srgb, var(--bg-container) 88%, transparent);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius-outer);
    box-shadow: var(--shadow-float);
    padding: var(--radius-padding);
  }

  .control {
    align-items: center;
    display: flex;
    gap: var(--space-050);
  }

  .controls :global(.btn[aria-disabled='true']) {
    cursor: progress;
    opacity: 1;
    pointer-events: auto;
  }

  .controls:not(.compact) :global(.icon-button:not(.device-caret)) {
    --button-height: var(--control-height-500);
    --button-icon-size: var(--size-x400);
  }

  .group {
    --radius-outer: var(--radius-inner);
    --radius-padding: var(--space-050);
    --tone: var(--sec-container);
    --tone-line: var(--sec-container-line);
    --ghost-hover: var(--sec-container-hover);
    --ghost-active: var(--sec-container-active);

    background: var(--tone);
    border: var(--border-width) solid var(--tone-line);
    border-radius: var(--radius-outer);
    box-sizing: border-box;
    color: var(--sec-on-container);
    gap: 0;
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

  .controls:not(.compact) .group :global(.btn) {
    --button-height: calc(
      var(--control-height-500) - var(--space-050) * 2 - var(--border-width) * 2
    );

    border-radius: max(0px, calc(var(--radius-outer) - var(--radius-padding)));
  }

  .divider {
    align-self: stretch;
    background: var(--tone-line);
    flex: none;
    inline-size: var(--border-width);
    margin: var(--space-150) var(--space-050);
  }

  .controls :global(.hang-up) {
    --button-container: var(--crit-main);
    --button-container-hover: var(--crit-main-hover);
    --button-container-active: var(--crit-main-active);
    --button-line: var(--crit-main-line);
    --button-on-container: var(--crit-on-main);
  }

  .controls:not(.compact) .action {
    margin-inline-start: var(--space-200);
  }

  .controls:not(.compact) :global(.hang-up) {
    margin-inline-start: var(--space-200);
    width: calc(var(--button-height) * 1.5);
  }

  @container call-dock (width < 34rem) {
    .controls:not(.compact) {
      gap: var(--space-100);
    }

    .controls:not(.compact) :global(.device-caret),
    .divider {
      display: none;
    }

    .controls:not(.compact) :global(.hang-up) {
      margin-inline-start: var(--space-100);
      width: calc(var(--button-height) * 1.3);
    }
  }

  .controls.compact {
    gap: var(--space-100);
    justify-content: flex-start;
  }

  .controls.compact .control:last-child {
    margin-inline-start: auto;
  }
</style>
