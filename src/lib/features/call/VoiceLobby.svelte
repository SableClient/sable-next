<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MicrophoneIcon from 'phosphor-svelte/lib/MicrophoneIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
  import SlidersHorizontalIcon from 'phosphor-svelte/lib/SlidersHorizontalIcon';
  import VideoCameraIcon from 'phosphor-svelte/lib/VideoCameraIcon';
  import VideoCameraSlashIcon from 'phosphor-svelte/lib/VideoCameraSlashIcon';
  import type { Snippet } from 'svelte';
  import type { MemberView } from '#src/generated/protocol';

  import { memberIdentity } from '#lib/features/room/members.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import ResponsivePopover from '#lib/ui/primitives/ResponsivePopover.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import CallDevicePreview from './CallDevicePreview.svelte';
  import { participantKeys } from './participant-keys.js';
  import type { CallMedia } from './call-session.svelte.js';

  interface Props {
    participants: readonly string[];
    members: readonly MemberView[];
    media: CallMedia;
    joining: boolean;
    canJoin: boolean;
    hasPermission: boolean;
    hasFocus?: boolean;
    roomName?: string;
    selfId?: string | null;
    onChange: (media: CallMedia) => void;
    onJoin: () => void;
  }

  let {
    participants,
    members,
    media,
    joining,
    canJoin,
    hasPermission,
    hasFocus = true,
    roomName,
    selfId = null,
    onChange,
    onJoin,
  }: Props = $props();

  const SHOWN = 6;

  let inVoice = $derived(participants.map((userId) => memberIdentity(members, userId)));
  let inVoiceKeys = $derived(participantKeys(inVoice.map((entry) => entry.userId)));
  let self = $derived(selfId ? memberIdentity(members, selfId) : null);
  let people = $derived([...new Set(inVoice.map((person) => person.name))]);
  let names = $derived(
    people.length > 3
      ? $i18n.t('call.lobbyNamesMore', {
          names: people.slice(0, 2).join(', '),
          count: people.length - 2,
        })
      : people.join(', ')
  );

  let devicesOpen = $state(false);
  let micLabel = $derived(
    media.microphone ? $i18n.t('call.microphoneOn') : $i18n.t('call.microphoneOff')
  );
  let cameraLabel = $derived(media.camera ? $i18n.t('call.cameraOn') : $i18n.t('call.cameraOff'));

  function join(): void {
    devicesOpen = false;
    onJoin();
  }
</script>

{#snippet tip(label: string, button: Snippet<[Record<string, unknown>]>)}
  <Tooltip {label}>
    {#snippet trigger({ props })}{@render button(props)}{/snippet}
  </Tooltip>
{/snippet}

<section class="lobby call-stage-theme" aria-label={$i18n.t('call.title')}>
  <div class="panel">
    {#if roomName}<h2>{roomName}</h2>{/if}

    {#if inVoice.length > 0}
      <ul class="faces" aria-label={$i18n.t('call.lobbyInCall', { count: inVoice.length })}>
        {#each inVoice.slice(0, SHOWN) as person, index (inVoiceKeys[index])}
          <li>
            <Avatar src={person.avatar} name={person.name} id={person.userId} size="large" />
            <span class="face-name">{person.name}</span>
          </li>
        {/each}
        {#if inVoice.length > SHOWN}
          <li class="more" aria-hidden="true">+{inVoice.length - SHOWN}</li>
        {/if}
      </ul>
      <p class="presence">
        <span class="live-dot"></span>
        <span class="count">{$i18n.t('call.lobbyInCall', { count: inVoice.length })}</span>
        <span class="names">{names}</span>
      </p>
    {:else}
      <p class="empty">{$i18n.t('call.lobbyEmpty')}</p>
    {/if}

    {#if canJoin}
      <div class="join-row">
        {#snippet micButton(props: Record<string, unknown>)}
          <IconButton
            {...props}
            variant="ghost"
            size="large"
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

        {#snippet cameraButton(props: Record<string, unknown>)}
          <IconButton
            {...props}
            variant="ghost"
            size="large"
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

        <Button
          variant="primary"
          size="large"
          class="join"
          disabled={joining}
          loading={joining}
          onclick={join}
        >
          <PhoneIcon aria-hidden="true" weight="fill" />
          {joining ? $i18n.t('call.joining') : $i18n.t('call.joinVoice')}
        </Button>

        <ResponsivePopover
          bind:open={devicesOpen}
          side="top"
          align="center"
          class="call-stage-theme call-devices-popover"
          label={$i18n.t('call.checkDevices')}
          closeLabel={$i18n.t('call.dismiss')}
        >
          {#snippet trigger({ props })}
            <Button {...props} variant="ghost" size="large" class="toggle devices-button">
              <SlidersHorizontalIcon aria-hidden="true" />
              {$i18n.t('call.checkDevices')}
            </Button>
          {/snippet}
          <div class="devices call-stage-theme">
            <CallDevicePreview {media} {onChange} {self} surface="call-stage-theme" />
          </div>
        </ResponsivePopover>
      </div>
    {:else if !hasPermission}
      <div class="closed">
        <p class="notice">{$i18n.t('call.lobbyNoPermission')}</p>
        <p class="hint">{$i18n.t('call.lobbyNoPermissionHint')}</p>
      </div>
    {:else if !hasFocus}
      <div class="closed">
        <p class="notice">{$i18n.t('call.lobbyNoFocus')}</p>
        <p class="hint">{$i18n.t('call.lobbyNoFocusHint')}</p>
      </div>
    {/if}
  </div>
</section>

<style>
  .lobby {
    background: var(--call-stage-bg);
    color: var(--bg-on-container);
    display: flex;
    flex: 1;
    justify-content: center;
    min-height: 0;
    overflow-y: auto;
  }

  .panel {
    align-items: center;
    align-self: center;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
    max-width: 40rem;
    padding: var(--space-700) var(--space-400);
    text-align: center;
    width: 100%;
  }

  h2 {
    font-size: var(--font-size-display);
    line-height: var(--line-height-heading);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .faces {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-400);
    justify-content: center;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .faces li {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-150);
    inline-size: 5rem;
  }

  .face-name {
    color: color-mix(in srgb, var(--bg-on-container) 78%, transparent);
    font-size: var(--font-size-small);
    max-inline-size: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .faces .more {
    align-items: center;
    align-self: flex-start;
    background: var(--surface-var-container);
    block-size: var(--avatar-size-500);
    border-radius: var(--radii-pill);
    color: var(--surface-var-on-container);
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-bold);
    inline-size: var(--avatar-size-500);
    justify-content: center;
  }

  .presence {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100) var(--space-200);
    justify-content: center;
    margin: 0;
  }

  .live-dot {
    align-self: center;
    background: var(--success-main);
    block-size: 0.5rem;
    border-radius: var(--radii-pill);
    box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--success-main) 28%, transparent);
    inline-size: 0.5rem;
  }

  .count {
    font-weight: var(--font-weight-bold);
  }

  .names {
    color: color-mix(in srgb, var(--bg-on-container) 72%, transparent);
    font-size: var(--font-size-small);
  }

  .empty,
  .hint {
    color: color-mix(in srgb, var(--bg-on-container) 72%, transparent);
    margin: 0;
  }

  .join-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    justify-content: center;
    margin-block-start: var(--space-200);
  }

  .join-row :global(.toggle) {
    --button-container: var(--surface-var-container);
    --button-container-hover: var(--surface-var-container-hover);
    --button-container-active: var(--surface-var-container-active);
    --button-line: transparent;
    --button-on-container: var(--surface-var-on-container);

    border-radius: var(--radii-pill);
  }

  .join-row :global(.toggle.off) {
    --button-container: var(--crit-container);
    --button-container-hover: var(--crit-container-hover);
    --button-container-active: var(--crit-container-active);
    --button-on-container: var(--crit-on-container);
  }

  .join-row :global(.toggle.on) {
    --button-container: var(--call-on-container);
    --button-container-hover: var(--call-on-container-hover);
    --button-container-active: var(--call-on-container-hover);
    --button-on-container: var(--call-on-ink);
  }

  .join-row :global(.join) {
    --button-container: var(--success-main);
    --button-container-hover: var(--success-main-hover);
    --button-container-active: var(--success-main-active);
    --button-line: transparent;
    --button-on-container: var(--success-on-main);

    border-radius: var(--radii-pill);
    min-inline-size: 11rem;
  }

  .devices {
    background: var(--bg-container);
    border-radius: var(--radii-500);
    color: var(--bg-on-container);
    inline-size: min(28rem, calc(100vw - 2rem));
    overflow: hidden;
  }

  .closed {
    display: grid;
    gap: var(--space-100);
  }

  .notice {
    color: var(--crit-main);
    margin: 0;
  }
</style>
