<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import CornersInIcon from 'phosphor-svelte/lib/CornersInIcon';
  import CornersOutIcon from 'phosphor-svelte/lib/CornersOutIcon';
  import LockIcon from 'phosphor-svelte/lib/LockSimpleIcon';
  import MicrophoneSlashIcon from 'phosphor-svelte/lib/MicrophoneSlashIcon';
  import MonitorArrowUpIcon from 'phosphor-svelte/lib/MonitorArrowUpIcon';
  import MonitorIcon from 'phosphor-svelte/lib/MonitorIcon';
  import SpeakerSlashIcon from 'phosphor-svelte/lib/SpeakerSlashIcon';
  import SquaresFourIcon from 'phosphor-svelte/lib/SquaresFourIcon';
  import TimerIcon from 'phosphor-svelte/lib/TimerIcon';
  import UserPlusIcon from 'phosphor-svelte/lib/UserPlusIcon';
  import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
  import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircleIcon';
  import { onDestroy } from 'svelte';
  import type { MemberView } from '#src/generated/protocol';

  import { memberIdentity, type MemberIdentity } from '#lib/features/room/members.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';

  import CallControls from './CallControls.svelte';
  import CallPlayback from './CallPlayback.svelte';
  import CallParticipantTile from './CallParticipantTile.svelte';
  import { bestGrid, callTiles, spotlightTile, type CallTile } from './call-layout';
  import type { CallSession } from './call-session.svelte.js';
  import { callFailureKey, callStatusKey } from './call-status';

  interface Props {
    session: CallSession;
    members: readonly MemberView[];
    onInvite?: () => void;
    onOpenSettings?: (event: MouseEvent) => void;
  }

  let { session, members, onInvite, onOpenSettings }: Props = $props();

  const CHROME_IDLE_MS = 3500;
  const GRID_GAP = 8;
  const NARROW_STAGE_PX = 560;

  let statusLabel = $derived(
    $i18n.t(
      callStatusKey({
        lifecycle: session.lifecycle,
        connection: session.transport.connection,
        mediaReady: session.mediaReady,
      })
    )
  );

  let byIdentity = $derived(
    new Map(session.members.map((member) => [member.identity, member.user_id]))
  );

  function profileOf(identity: string): MemberIdentity {
    return memberIdentity(members, byIdentity.get(identity) ?? identity);
  }

  let busy = $derived(session.lifecycle === 'joining' || session.lifecycle === 'connecting');
  let ready = $derived(session.mediaReady && session.lifecycle === 'active');
  let health = $derived(
    session.failure
      ? 'failed'
      : session.lifecycle === 'active' && session.transport.connection === 'reconnecting'
        ? 'reconnecting'
        : 'live'
  );
  let settled = $derived(ready && health === 'live' && session.deviceError === null);

  let tiles = $derived(
    callTiles(
      session.transport.self
        ? [session.transport.self, ...session.transport.participants]
        : session.transport.participants
    )
  );
  let others = $derived(
    tiles.filter((tile) => tile.source === 'camera' && !tile.participant.local).length
  );
  let failed = $derived(session.failure !== null);
  let alone = $derived(ready && tiles.length === 1 && tiles[0].participant.local === true);

  let pinned = $state<string | null>(null);
  let gridForced = $state(false);
  let spotlight = $derived(pinned === null && gridForced ? null : spotlightTile(tiles, pinned));
  let strip = $derived(spotlight ? tiles.filter((tile) => tile.key !== spotlight.key) : []);
  let canSpotlight = $derived(pinned !== null || tiles.some((tile) => tile.source === 'screen'));

  let noticeHeight = $state(0);
  let mediaWidth = $state(0);
  let mediaHeight = $state(0);
  let aspect = $derived(mediaWidth > 0 && mediaWidth < NARROW_STAGE_PX ? 1 : 16 / 9);
  let grid = $derived(bestGrid(tiles.length, mediaWidth, mediaHeight, GRID_GAP, aspect));

  function togglePin(tile: CallTile): void {
    if (pinned === tile.key) {
      pinned = null;
      return;
    }
    pinned = tile.key;
    gridForced = false;
  }

  function toggleLayout(): void {
    if (spotlight) {
      pinned = null;
      gridForced = true;
    } else {
      gridForced = false;
    }
  }

  let now = $state(Date.now());
  $effect(() => {
    if (session.connectedAt === null) return;
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function elapsed(since: number, until: number): string {
    const seconds = Math.max(0, Math.floor((until - since) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(hours > 0 ? 2 : 1, '0');
    const rest = String(seconds % 60).padStart(2, '0');
    return hours > 0 ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`;
  }

  const DEVICE_ERROR_KEY = {
    microphone: 'call.microphoneUnavailable',
    camera: 'call.cameraUnavailable',
    screen: 'call.screenShareUnavailable',
  } as const;

  let stage = $state<HTMLElement>();
  let fullscreen = $state(false);
  const fullscreenAvailable =
    typeof document !== 'undefined' &&
    document.fullscreenEnabled &&
    typeof HTMLElement.prototype.requestFullscreen === 'function';

  function toggleFullscreen(): void {
    if (fullscreen) void document.exitFullscreen();
    else void stage?.requestFullscreen();
  }

  let chromeVisible = $state(true);
  let chromeHeld = $state(false);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  function wake(): void {
    chromeVisible = true;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (settled && !chromeHeld) chromeVisible = false;
    }, CHROME_IDLE_MS);
  }

  function rest(): void {
    clearTimeout(idleTimer);
    if (settled && !chromeHeld) chromeVisible = false;
  }

  $effect(() => {
    if (!settled) chromeVisible = true;
  });

  function trackOverflow(node: HTMLElement) {
    const observer = new ResizeObserver(() => {
      node.dataset.overflow = String(
        node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1
      );
    });
    observer.observe(node);
    return () => observer.disconnect();
  }

  function openCallSettings(event: MouseEvent): void {
    if (fullscreen) void document.exitFullscreen();
    onOpenSettings?.(event);
  }

  onDestroy(() => clearTimeout(idleTimer));
</script>

<svelte:document onfullscreenchange={() => (fullscreen = document.fullscreenElement === stage)} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="stage call-stage-theme"
  class:resting={!chromeVisible}
  aria-label={$i18n.t('call.title')}
  bind:this={stage}
  onpointermove={wake}
  onpointerdown={wake}
  onpointerleave={(event) => {
    if (event.pointerType === 'mouse') rest();
  }}
  onkeydown={wake}
  onfocusin={() => {
    chromeHeld = true;
    wake();
  }}
  onfocusout={() => (chromeHeld = false)}
>
  <header class="top chrome">
    <p class="status" role="status">
      {#if busy}
        <Spinner small />
      {:else}
        <span class="live-dot {health}"></span>
      {/if}
      <span>{statusLabel}</span>
      {#if session.connectedAt !== null && !failed}
        <span class="meta" title={$i18n.t('call.duration')}>
          <TimerIcon aria-hidden="true" weight="bold" />
          <span class="screen-reader-only">{$i18n.t('call.duration')}</span>
          {elapsed(session.connectedAt, now)}
        </span>
      {/if}
      {#if ready && others > 0}
        <span class="meta" title={$i18n.t('call.others', { count: others })}>
          <UsersIcon aria-hidden="true" weight="bold" />
          {others}
          <span class="screen-reader-only">{$i18n.t('call.others', { count: others })}</span>
        </span>
      {/if}
      {#if session.encryptsMedia && !failed}
        <span class="encrypted" title={$i18n.t('call.encrypted')}>
          <LockIcon aria-hidden="true" weight="bold" />
          <span class="screen-reader-only">{$i18n.t('call.encrypted')}</span>
        </span>
      {/if}
    </p>
    <div class="top-actions">
      {#if canSpotlight}
        <IconButton
          variant="ghost"
          size="small"
          class="stage-action"
          label={$i18n.t(spotlight ? 'call.gridView' : 'call.focusView')}
          onclick={toggleLayout}
        >
          {#if spotlight}
            <SquaresFourIcon weight="fill" />
          {:else}
            <MonitorIcon weight="fill" />
          {/if}
        </IconButton>
      {/if}
      {#if fullscreenAvailable}
        <IconButton
          variant="ghost"
          size="small"
          class="stage-action"
          label={$i18n.t(fullscreen ? 'call.exitFullscreen' : 'call.fullscreen')}
          onclick={toggleFullscreen}
        >
          {#if fullscreen}
            <CornersInIcon weight="bold" />
          {:else}
            <CornersOutIcon weight="bold" />
          {/if}
        </IconButton>
      {/if}
    </div>
  </header>

  {#if !failed}
    <div class="dock chrome">
      <CallControls
        microphoneEnabled={session.transport.microphoneEnabled}
        cameraEnabled={session.transport.cameraEnabled}
        screenShareEnabled={session.transport.screenShareEnabled}
        deafened={session.deafened}
        {ready}
        canScreenShare={session.canScreenShare}
        onToggleMicrophone={() =>
          void session.setMicrophoneEnabled(!session.transport.microphoneEnabled)}
        onToggleCamera={() => void session.setCameraEnabled(!session.transport.cameraEnabled)}
        onToggleScreenShare={() =>
          void session.setScreenShareEnabled(!session.transport.screenShareEnabled)}
        onToggleDeafen={() => session.setDeafened(!session.deafened)}
        onHangUp={() => void session.leave()}
        onSwitchDevice={session.canSwitchCamera
          ? undefined
          : (kind, deviceId) => void session.switchDevice(kind, deviceId)}
        onSwitchCamera={session.canSwitchCamera ? () => void session.switchCamera() : undefined}
        onOpenSettings={onOpenSettings ? openCallSettings : undefined}
      />
      {#if busy}
        <p class="securing">{$i18n.t('call.controlsLocked')}</p>
      {/if}
    </div>
  {/if}

  <div class="notices" bind:clientHeight={noticeHeight}>
    {#if session.deviceError}
      <div class="notice critical" role="alert">
        <WarningCircleIcon aria-hidden="true" weight="fill" />
        <p>{$i18n.t(DEVICE_ERROR_KEY[session.deviceError])}</p>
        <div class="notice-actions">
          <Button variant="ghost" onclick={() => session.clearDeviceError()}>
            {$i18n.t('call.dismiss')}
          </Button>
          {#if onOpenSettings}
            <Button
              variant="primary"
              onclick={(event: MouseEvent) => {
                session.clearDeviceError();
                openCallSettings(event);
              }}
            >
              {$i18n.t('call.openSettings')}
            </Button>
          {/if}
        </div>
      </div>
    {/if}
    <CallPlayback rooms={session.rooms} telemetry={session.telemetry} />
  </div>

  <div
    class="media"
    class:with-notice={session.deviceError !== null}
    class:locked={busy}
    style:--tile-aspect={aspect}
    style:--notice-height="{noticeHeight}px"
  >
    {#if session.failure}
      <div class="failed-panel" role="alert">
        <span class="failed-mark"><WarningCircleIcon aria-hidden="true" weight="fill" /></span>
        <h2>{$i18n.t('call.failed')}</h2>
        <p>{$i18n.t(callFailureKey(session.failure))}</p>
        <div class="failed-actions">
          <Button variant="secondary" onclick={() => session.clearFailure()}>
            {$i18n.t('call.leave')}
          </Button>
          {#if session.failure !== 'busy'}
            <Button variant="primary" onclick={() => void session.retry()}>
              {$i18n.t('call.retry')}
            </Button>
          {/if}
        </div>
      </div>
    {:else if tiles.length === 0}
      <p class="empty">{$i18n.t('call.noParticipants')}</p>
    {:else if spotlight}
      <div class="focus">
        <ul class="featured">
          {@render tile(spotlight, true)}
        </ul>
        {#if strip.length > 0}
          <ul
            class="strip"
            aria-label={$i18n.t('call.participants', { count: strip.length })}
            {@attach trackOverflow}
          >
            {#each strip as item (item.key)}
              {@render tile(item, false)}
            {/each}
          </ul>
        {/if}
      </div>
    {:else}
      <ul
        class="grid"
        class:alone
        bind:clientWidth={mediaWidth}
        bind:clientHeight={mediaHeight}
        style:--tile-width="{Math.floor(grid.width)}px"
        style:--grid-gap="{GRID_GAP}px"
      >
        {#each tiles as item (item.key)}
          {@render tile(item, false)}
        {/each}
        {#if alone}
          <li class="waiting">
            <p>{$i18n.t('call.noParticipants')}</p>
            {#if onInvite}
              <Button variant="secondary" onclick={onInvite}>
                <UserPlusIcon aria-hidden="true" weight="bold" />
                {$i18n.t('call.invite')}
              </Button>
            {/if}
          </li>
        {/if}
      </ul>
    {/if}
  </div>

  {#if !chromeVisible && (!session.transport.microphoneEnabled || session.deafened || session.transport.screenShareEnabled)}
    <div class="indicators" aria-hidden="true">
      {#if !session.transport.microphoneEnabled}
        <span class="indicator off"><MicrophoneSlashIcon weight="fill" /></span>
      {/if}
      {#if session.deafened}
        <span class="indicator off"><SpeakerSlashIcon weight="fill" /></span>
      {/if}
      {#if session.transport.screenShareEnabled}
        <span class="indicator live"><MonitorArrowUpIcon weight="fill" /></span>
      {/if}
    </div>
  {/if}
</section>

{#snippet tile(item: CallTile, featured: boolean)}
  {@const profile = profileOf(item.participant.identity)}
  <CallParticipantTile
    participant={item.participant}
    source={item.source}
    room={session.roomFor(item.participant.backendId)}
    name={profile.name}
    userId={profile.userId}
    avatar={profile.avatar}
    {featured}
    pinned={pinned === item.key}
    onPin={tiles.length > 1 ? () => togglePin(item) : undefined}
    onVolumeChange={(identity, volume) => void session.setParticipantVolume(identity, volume)}
  />
{/snippet}

<style>
  .stage {
    --stage-bg: var(--call-stage-bg);
    --stage-scrim: var(--call-stage-scrim);
    --call-tile-bg: var(--call-stage-tile);

    background: var(--stage-bg);
    box-sizing: border-box;
    color: var(--picker-white);
    color-scheme: dark;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    position: relative;
  }

  .stage.resting {
    cursor: none;
  }

  .chrome {
    transition:
      opacity var(--motion-slow) var(--motion-easing-emphasized),
      translate var(--motion-slow) var(--motion-easing-emphasized);
  }

  .resting .chrome,
  .resting :global(.tile .actions:not(:focus-within)) {
    opacity: 0;
    pointer-events: none;
  }

  .top {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    inset: 0 0 auto;
    justify-content: space-between;
    padding: var(--space-200) var(--space-300);
    pointer-events: none;
    position: absolute;
    z-index: 2;
  }

  .top > * {
    pointer-events: auto;
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
    padding: var(--space-100) var(--space-300);
  }

  .meta {
    align-items: center;
    border-inline-start: var(--border-width) solid var(--bg-container-line);
    color: color-mix(in srgb, var(--bg-on-container) 78%, transparent);
    display: inline-flex;
    font-variant-numeric: tabular-nums;
    gap: var(--space-100);
    padding-inline-start: var(--space-150);
  }

  .live-dot {
    background: var(--success-main);
    block-size: 0.5rem;
    border-radius: var(--radii-pill);
    box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--success-main) 28%, transparent);
    inline-size: 0.5rem;
  }

  .live-dot.reconnecting {
    background: var(--warn-main);
    box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--warn-main) 28%, transparent);
  }

  .live-dot.failed {
    background: var(--crit-main);
    box-shadow: 0 0 0 0.1875rem color-mix(in srgb, var(--crit-main) 28%, transparent);
  }

  .encrypted {
    color: var(--success-main);
    display: inline-flex;
  }

  .top-actions {
    display: flex;
    gap: var(--space-100);
  }

  .top-actions :global(.stage-action) {
    --button-container: var(--bg-container);
    --button-container-hover: var(--bg-container-hover);
    --button-container-active: var(--bg-container-active);

    color: var(--bg-on-container);
  }

  .notices {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    inset: calc(var(--space-200) + var(--control-height-300) + var(--space-200)) var(--space-300)
      auto;
    pointer-events: none;
    position: absolute;
    z-index: 3;
  }

  .notices > :global(*) {
    pointer-events: auto;
  }

  .notice {
    align-items: center;
    background: var(--bg-container);
    border: var(--border-width) solid var(--crit-container-line, var(--bg-container-line));
    border-radius: var(--radii-400);
    box-shadow: var(--call-stage-notice-shadow);
    color: var(--bg-on-container);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    max-inline-size: min(34rem, 100%);
    padding: var(--space-200) var(--space-200) var(--space-200) var(--space-300);
  }

  .notice > :global(svg) {
    color: var(--crit-main);
    flex: none;
    height: var(--size-x400);
    width: var(--size-x400);
  }

  .notice p {
    flex: 1 1 12rem;
    font-size: var(--font-size-small);
    margin: 0;
  }

  .notice-actions {
    display: flex;
    gap: var(--space-100);
    margin-inline-start: auto;
  }

  .media {
    box-sizing: border-box;
    container-type: size;
    display: flex;
    flex: 1;
    min-height: 0;
    padding: calc(var(--space-200) + var(--control-height-300) + var(--space-200)) var(--space-300)
      calc(var(--control-height-500) + var(--space-150) * 2 + var(--space-300) * 2);
  }

  .media.with-notice {
    padding-block-start: calc(
      var(--space-200) + var(--control-height-300) + var(--space-400) + var(--notice-height)
    );
  }

  .media.locked {
    padding-block-end: calc(
      var(--control-height-500) + var(--space-150) * 3 + var(--space-300) * 2 + var(--space-500)
    );
  }

  .failed-panel {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    margin: auto;
    max-inline-size: 26rem;
    text-align: center;
  }

  .failed-mark {
    align-items: center;
    background: var(--crit-container);
    block-size: var(--control-height-500);
    border-radius: var(--radii-pill);
    color: var(--crit-on-container);
    display: inline-flex;
    inline-size: var(--control-height-500);
    justify-content: center;
  }

  .failed-mark :global(svg) {
    height: var(--size-x400);
    width: var(--size-x400);
  }

  .failed-panel h2 {
    font-size: var(--font-size-heading);
    margin: var(--space-100) 0 0;
  }

  .failed-panel p {
    color: color-mix(in srgb, var(--bg-on-container) 75%, transparent);
    margin: 0;
  }

  .failed-actions {
    display: flex;
    gap: var(--space-200);
    margin-block-start: var(--space-300);
  }

  .empty {
    color: color-mix(in srgb, var(--picker-white) 70%, transparent);
    font-size: var(--font-size-small);
    margin: auto;
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
    gap: var(--space-200);
  }

  .waiting p {
    color: color-mix(in srgb, var(--picker-white) 78%, transparent);
    font-size: var(--font-size-body);
    margin: 0;
  }

  .focus {
    display: flex;
    flex: 1;
    gap: var(--space-200);
    min-height: 0;
    min-width: 0;
  }

  .featured {
    display: flex;
    flex: 1;
    list-style: none;
    margin: 0;
    min-height: 0;
    min-width: 0;
    padding: 0;
  }

  .featured > :global(.tile) {
    flex: 1;
  }

  .strip {
    display: flex;
    flex: 0 0 clamp(8rem, 20%, 15rem);
    flex-direction: column;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    overflow-y: auto;
    padding: 0;
    scroll-snap-type: y proximity;
    scrollbar-width: thin;
  }

  .strip:global([data-overflow='true']) {
    mask-image: linear-gradient(to bottom, black calc(100% - var(--space-700)), transparent);
    padding-block-end: var(--space-700);
  }

  .strip > :global(.tile) {
    aspect-ratio: 16 / 9;
    flex: none;
    scroll-snap-align: start;
  }

  @container (aspect-ratio < 1.1) {
    .focus {
      flex-direction: column;
    }

    .strip {
      flex: 0 0 clamp(4.5rem, 22%, 8rem);
      flex-direction: row;
      overflow: auto hidden;
      scroll-snap-type: x proximity;
    }

    .strip:global([data-overflow='true']) {
      mask-image: linear-gradient(to right, black calc(100% - var(--space-800)), transparent);
      padding-block-end: 0;
      padding-inline-end: var(--space-800);
    }

    .strip > :global(.tile) {
      block-size: 100%;
    }
  }

  .indicators {
    display: flex;
    gap: var(--space-100);
    inset: auto auto var(--space-300) var(--space-300);
    position: absolute;
    z-index: 2;
  }

  .indicator {
    align-items: center;
    border-radius: var(--radii-pill);
    display: inline-flex;
    height: var(--control-height-300);
    justify-content: center;
    width: var(--control-height-300);
  }

  .indicator :global(svg) {
    height: var(--size-x200);
    width: var(--size-x200);
  }

  .indicator.off {
    background: var(--crit-container);
    color: var(--crit-on-container);
  }

  .indicator.live {
    background: var(--call-on-container);
    color: var(--call-on-ink);
  }

  .dock {
    align-items: center;
    container: call-dock / inline-size;
    display: flex;
    flex-direction: column;
    gap: var(--space-150);
    inset: auto 0 0;
    justify-content: center;
    padding: var(--space-300);
    pointer-events: none;
    position: absolute;
    z-index: 2;
  }

  .securing {
    color: color-mix(in srgb, var(--bg-on-container) 75%, transparent);
    font-size: var(--font-size-small);
    margin: 0;
    order: -1;
  }

  .dock > :global(*) {
    pointer-events: auto;
  }

  .resting .top {
    translate: 0 -0.5rem;
  }

  .resting .dock {
    translate: 0 0.5rem;
  }
</style>
