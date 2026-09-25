<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import PhoneIcon from 'phosphor-svelte/lib/PhoneIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
  import type { MemberView } from '#src/generated/protocol';

  import { memberIdentity } from '#lib/features/room/members.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import CallControls from './CallControls.svelte';
  import LobbyTile from './LobbyTile.svelte';
  import { bestGrid, GRID_GAP_PX, NARROW_STAGE_PX } from './call-layout';
  import { DEVICE_PREFERENCE } from './devices';
  import { participantKeys } from './participant-keys.js';
  import type { CallMedia } from './call-session.svelte.js';
  import { startInputMeter } from './input-meter';

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
    onOpenSettings?: (event: MouseEvent) => void;
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
    onOpenSettings,
  }: Props = $props();

  const SPEAKING_LEVEL = 0.08;

  let self = $derived(selfId ? memberIdentity(members, selfId) : null);
  let others = $derived(
    participants
      .filter((userId) => userId !== selfId)
      .map((userId) => memberIdentity(members, userId))
  );
  let otherKeys = $derived(participantKeys(others.map((person) => person.userId)));
  let alone = $derived(others.length === 0);

  let mediaWidth = $state(0);
  let mediaHeight = $state(0);
  let aspect = $derived(mediaWidth > 0 && mediaWidth < NARROW_STAGE_PX ? 1 : 16 / 9);
  let grid = $derived(
    bestGrid(alone ? 1 : others.length + 1, mediaWidth, mediaHeight, GRID_GAP_PX, aspect)
  );

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

  function selectDevice(kind: MediaDeviceKind, deviceId: string): void {
    setPreference(DEVICE_PREFERENCE[kind], deviceId);
  }
</script>

{#snippet testMic()}
  {#snippet testButton(props: Record<string, unknown>)}
    <Button
      {...props}
      variant="secondary"
      size="large"
      class="test-mic"
      aria-disabled={media.microphone ? undefined : 'true'}
      aria-pressed={testing && media.microphone}
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
    <Tooltip label={$i18n.t('call.testMicNeedsMic')}>
      {#snippet trigger({ props })}{@render testButton(props)}{/snippet}
    </Tooltip>
  {/if}
{/snippet}

{#snippet joinAction()}
  <Button variant="primary" size="large" disabled={joining} loading={joining} onclick={onJoin}>
    <PhoneIcon aria-hidden="true" weight="fill" />
    {joining ? $i18n.t('call.joining') : $i18n.t('call.joinVoice')}
  </Button>
{/snippet}

<section class="lobby" aria-label={$i18n.t('call.title')}>
  <header class="top">
    <p class="status">
      <span class="live-dot" class:idle={alone}></span>
      {#if roomName}<span class="room">{roomName}</span>{/if}
      {#if !alone}
        <span class="meta" title={$i18n.t('call.lobbyInCall', { count: others.length })}>
          <UsersIcon aria-hidden="true" weight="bold" />
          {others.length}
          <span class="screen-reader-only">
            {$i18n.t('call.lobbyInCall', { count: others.length })}
          </span>
        </span>
      {/if}
    </p>
  </header>

  <div class="media" style:--tile-aspect={aspect}>
    {#if canJoin}
      <ul
        class="grid"
        class:alone
        bind:clientWidth={mediaWidth}
        bind:clientHeight={mediaHeight}
        style:--tile-width="{Math.floor(grid.width)}px"
        style:--grid-gap="{GRID_GAP_PX}px"
      >
        {#if self}
          <LobbyTile
            name={self.name}
            userId={self.userId}
            avatar={self.avatar}
            muted={!media.microphone}
            speaking={testing && meterReady && level > SPEAKING_LEVEL}
            stream={wantsCamera ? stream : undefined}
            note={cameraFailed
              ? $i18n.t('call.cameraUnavailable')
              : $i18n.t('call.prescreenNoCamera')}
          />
        {/if}
        {#each others as person, index (otherKeys[index])}
          <LobbyTile name={person.name} userId={person.userId} avatar={person.avatar} />
        {/each}
        {#if alone}
          <li class="waiting"><p>{$i18n.t('call.lobbyEmpty')}</p></li>
        {/if}
      </ul>
    {:else if !hasPermission}
      <Alert variant="warning" class="closed" title={$i18n.t('call.lobbyNoPermission')}>
        <p>{$i18n.t('call.lobbyNoPermissionHint')}</p>
      </Alert>
    {:else if !hasFocus}
      <Alert variant="warning" class="closed" title={$i18n.t('call.lobbyNoFocus')}>
        <p>{$i18n.t('call.lobbyNoFocusHint')}</p>
      </Alert>
    {/if}
  </div>

  {#if canJoin}
    <div class="dock">
      <CallControls
        microphoneEnabled={media.microphone}
        cameraEnabled={media.camera}
        screenShareEnabled={false}
        deafened={false}
        ready
        canScreenShare={false}
        onToggleMicrophone={() => onChange({ ...media, microphone: !media.microphone })}
        onToggleCamera={() => onChange({ ...media, camera: !media.camera })}
        onToggleScreenShare={() => {}}
        onSwitchDevice={selectDevice}
        {onOpenSettings}
        extra={testMic}
        action={joinAction}
      />
    </div>
  {/if}
</section>

<style>
  .lobby {
    background: var(--surface-container);
    box-sizing: border-box;
    color: var(--surface-on-container);
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .top {
    display: flex;
    padding: var(--space-200) var(--space-300);
  }

  .status {
    align-items: center;
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radii-pill);
    color: var(--bg-on-container);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: var(--space-150);
    margin: 0;
    max-inline-size: 100%;
    min-width: 0;
    padding: var(--space-100) var(--space-300);
  }

  .room {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    align-items: center;
    border-inline-start: var(--border-width) solid var(--bg-container-line);
    color: var(--surface-var-on-container);
    display: inline-flex;
    flex: none;
    font-variant-numeric: tabular-nums;
    gap: var(--space-100);
    padding-inline-start: var(--space-150);
  }

  .live-dot {
    background: var(--success-main);
    block-size: 0.5rem;
    border-radius: var(--radii-pill);
    box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--success-main) 28%, transparent);
    flex: none;
    inline-size: 0.5rem;
  }

  .live-dot.idle {
    background: var(--surface-var-on-container);
    box-shadow: none;
  }

  .media {
    box-sizing: border-box;
    display: flex;
    flex: 1;
    min-height: 0;
    padding: 0 var(--space-300);
  }

  .media > :global(.closed) {
    margin: auto;
    max-inline-size: 28rem;
    text-align: center;
  }

  .grid {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: var(--grid-gap);
    list-style: none;
    margin: 0;
    padding: 0;
    place-content: center;
  }

  .grid > :global(.tile) {
    aspect-ratio: var(--tile-aspect);
    inline-size: var(--tile-width);
  }

  .grid.alone {
    align-content: center;
    flex-flow: column nowrap;
    gap: var(--space-400);
  }

  .grid.alone > :global(.tile) {
    align-self: center;
    inline-size: min(var(--tile-width), 26rem);
  }

  .waiting {
    align-items: center;
    display: flex;
    flex-direction: column;
  }

  .waiting p {
    color: var(--surface-var-on-container);
    margin: 0;
  }

  .dock {
    align-items: center;
    container: call-dock / inline-size;
    display: flex;
    justify-content: center;
    padding: var(--space-300);
  }

  .dock :global(.btn.test-mic[aria-disabled='true']) {
    opacity: var(--opacity-disabled);
  }
</style>
