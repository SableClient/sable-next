<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import VideoCameraSlashIcon from 'phosphor-svelte/lib/VideoCameraSlashIcon';
  import MonitorArrowUpIcon from 'phosphor-svelte/lib/MonitorArrowUpIcon';
  import HeadphonesIcon from 'phosphor-svelte/lib/HeadphonesIcon';
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
    onSwitchDevice?: (kind: MediaDeviceKind, deviceId: string) => void;
    onOpenSettings?: (event: MouseEvent) => void;
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
    onOpenSettings,
  }: Props = $props();

  let size = $derived<'small' | 'medium'>(compact ? 'small' : 'medium');
  let devices = $derived(compact ? undefined : onSwitchDevice);
  let pending = $derived(ready ? '' : ` · ${$i18n.t('call.waitingForMedia')}`);
  let surface = $derived(compact ? undefined : 'call-stage-theme');
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
  onHold?: () => void
)}
  <div
    class="control"
    class:grouped={menu !== undefined}
    {@attach longPress({ enabled: () => onHold !== undefined, onPress: () => onHold?.() })}
  >
    <Tooltip label={tip}>
      {#snippet trigger({ props })}{@render button(props)}{/snippet}
    </Tooltip>
    {@render menu?.()}
  </div>
{/snippet}

<div class="controls" class:compact>
  {#snippet micButton(props: Record<string, unknown>)}
    <IconButton
      {...props}
      variant="ghost"
      class={['toggle', !microphoneEnabled && 'off']}
      {size}
      label={micLabel}
      disabled={!ready}
      onclick={onToggleMicrophone}
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
        {surface}
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
    devices ? () => (micMenu = true) : undefined
  )}

  {#snippet deafenButton(props: Record<string, unknown>)}
    <IconButton
      {...props}
      variant="ghost"
      class={['toggle', deafened && 'off']}
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
  {/snippet}
  {#snippet deafenMenu()}
    {#if devices}
      <CallDeviceMenu
        bind:open={outputMenu}
        {surface}
        kinds={['audiooutput']}
        label={$i18n.t('call.outputDevices')}
        onSelect={devices}
      />
    {/if}
  {/snippet}
  {@render control(
    `${deafenLabel}${shortcut('call.toggleDeafen')}`,
    deafenButton,
    deafenMenu,
    devices ? () => (outputMenu = true) : undefined
  )}

  {#snippet cameraButton(props: Record<string, unknown>)}
    <IconButton
      {...props}
      variant="ghost"
      class={['toggle', cameraEnabled && 'on']}
      {size}
      label={cameraLabel}
      disabled={!ready}
      onclick={onToggleCamera}
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
        {surface}
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
    devices ? () => (cameraMenu = true) : undefined
  )}

  {#if canScreenShare}
    {#snippet screenButton(props: Record<string, unknown>)}
      <IconButton
        {...props}
        variant="ghost"
        class={['toggle', screenShareEnabled && 'on']}
        {size}
        label={screenLabel}
        disabled={!ready}
        onclick={onToggleScreenShare}
      >
        <MonitorArrowUpIcon weight={screenShareEnabled ? 'fill' : 'regular'} />
      </IconButton>
    {/snippet}
    {@render control(`${screenLabel}${shortcut('call.toggleScreenShare')}${pending}`, screenButton)}
  {/if}

  {#if onOpenSettings}
    {#snippet settingsButton(props: Record<string, unknown>)}
      <IconButton
        {...props}
        variant="ghost"
        class="toggle"
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
  {@render control(`${$i18n.t('call.hangUp')}${shortcut('call.hangUp')}`, hangUpButton)}
</div>

<style>
  .controls {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    justify-content: center;
  }

  .controls:not(.compact) {
    backdrop-filter: blur(0.75rem);
    background: color-mix(in srgb, var(--bg-container) 88%, transparent);
    border-radius: var(--radii-pill);
    box-shadow: var(--call-pill-shadow, var(--shadow-float));
    padding: var(--space-150);
  }

  .control {
    align-items: center;
    display: flex;
  }

  .control.grouped {
    background: var(--surface-var-container);
    border-radius: var(--radii-pill);
  }

  .control.grouped:has(:global(.toggle.off)) {
    --surface-var-container-hover: var(--crit-container-hover);
    --surface-var-on-container: var(--crit-on-container);

    background: var(--crit-container);
  }

  .controls.compact .control.grouped {
    background: none;
  }

  .control :global(.device-caret) {
    --button-container: transparent;
    --button-container-hover: var(--surface-var-container-hover);
    --button-on-container: var(--surface-var-on-container);

    border-radius: var(--radii-pill);
    margin-inline: calc(-1 * var(--space-050)) var(--space-050);
    width: 1.75rem;
  }

  .controls:not(.compact) .control :global(.device-caret) {
    --button-height: var(--control-height-500);
  }

  .controls :global(.toggle) {
    --button-container: var(--surface-var-container);
    --button-container-hover: var(--surface-var-container-hover);
    --button-container-active: var(--surface-var-container-active);
    --button-line: transparent;
    --button-on-container: var(--surface-var-on-container);
  }

  .controls:not(.compact) :global(.btn) {
    border-radius: var(--radii-pill);
  }

  .controls:not(.compact) :global(.icon-button:not(.device-caret)) {
    --button-height: var(--control-height-500);
    --button-icon-size: var(--size-x400);
  }

  .controls :global(.toggle.off) {
    --button-container: var(--crit-container);
    --button-container-hover: var(--crit-container-hover);
    --button-container-active: var(--crit-container-active);
    --button-on-container: var(--crit-on-container);
  }

  .controls :global(.toggle.on) {
    --button-container: var(--call-on-container, var(--primary-container));
    --button-container-hover: var(--call-on-container-hover, var(--primary-container-hover));
    --button-container-active: var(--call-on-container-hover, var(--primary-container-active));
    --button-on-container: var(--call-on-ink, var(--primary-on-container));
  }

  .controls :global(.hang-up) {
    --button-container: var(--call-hangup, var(--crit-main));
    --button-container-hover: var(--call-hangup-hover, var(--crit-main-hover));
    --button-container-active: var(--call-hangup-active, var(--crit-main-active));
    --button-line: transparent;
    --button-on-container: var(--call-hangup-ink, var(--crit-on-main));
  }

  .controls:not(.compact) :global(.hang-up) {
    margin-inline-start: var(--space-200);
    width: calc(var(--button-height) * 1.5);
  }

  @container call-dock (width < 34rem) {
    .controls:not(.compact) {
      gap: var(--space-100);
      padding: var(--space-100);
    }

    .controls:not(.compact) :global(.device-caret) {
      display: none;
    }

    .controls:not(.compact) :global(.hang-up) {
      margin-inline-start: var(--space-100);
      width: calc(var(--button-height) * 1.3);
    }
  }

  .controls.compact {
    gap: var(--space-150);
    justify-content: space-between;
  }

  .controls.compact :global(.hang-up) {
    margin-inline-start: var(--space-300);
  }
</style>
