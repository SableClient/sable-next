<script lang="ts">
  import ArrowSquareOutIcon from 'phosphor-svelte/lib/ArrowSquareOutIcon';
  import MonitorIcon from 'phosphor-svelte/lib/MonitorIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { Track, type RemoteTrack } from 'livekit-client';
  import { untrack } from 'svelte';
  import { on } from 'svelte/events';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import { callTiles, featuredTiles, type CallTile } from './call-layout';
  import type { CallSession } from './call-session.svelte.js';
  import {
    dismissedPreview,
    previewCorner,
    type PreviewCorner,
  } from './screen-share-preview.svelte.js';

  interface Props {
    session: CallSession;
    onReturn: () => void;
  }

  let { session, onReturn }: Props = $props();
  const core = useCoreClient();

  type PipWindow = Window & { document: Document };
  type DocumentPip = {
    requestWindow: (options: { width: number; height: number }) => Promise<PipWindow>;
  };

  let tiles = $derived(
    callTiles(
      session.transport.self
        ? [session.transport.self, ...session.transport.participants]
        : session.transport.participants,
      session.watchedScreenShareIds
    ).filter((tile) => tile.source === 'screen' && !tile.participant.local)
  );
  let shown = $derived.by<CallTile | undefined>(() => {
    const featured = featuredTiles(tiles, session.layout.pinned).find(
      (tile) => tile.source === 'screen' && !tile.participant.local
    );
    return featured ?? tiles[0];
  });
  let room = $derived(shown ? session.roomFor(shown.participant.backendId) : undefined);
  let sharerId = $derived.by(() => {
    if (!shown) return null;
    const identity = shown.participant.identity;
    return session.members.find((member) => member.identity === identity)?.user_id ?? identity;
  });
  let sharerName = $state<string | null>(null);
  let label = $derived($i18n.t('call.screenOf', { name: sharerName ?? sharerId ?? '' }));

  $effect(() => {
    const userId = sharerId;
    sharerName = null;
    if (userId === null) return;
    let current = true;
    core.userProfile(userId).then(
      (profile) => {
        if (current) sharerName = profile.display_name ?? null;
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  });

  let video = $state<HTMLVideoElement | null>(null);
  let popped = $state<'document' | 'video' | null>(null);
  let drag = $state<{ x: number; y: number } | null>(null);
  function canPopOut(): boolean {
    return 'documentPictureInPicture' in window || document.pictureInPictureEnabled;
  }

  function track(): RemoteTrack | undefined {
    if (!shown || !room) return undefined;
    return room.remoteParticipants
      .get(shown.participant.identity)
      ?.getTrackPublication(Track.Source.ScreenShare)?.track;
  }

  function attach(node: HTMLVideoElement) {
    const media = untrack(track);
    media?.attach(node);
    return () => {
      media?.detach(node);
    };
  }

  async function popOut(): Promise<void> {
    const media = track();
    if (!media) return;
    const pip = (window as Window & { documentPictureInPicture?: DocumentPip })
      .documentPictureInPicture;
    if (pip) {
      const opened = await pip.requestWindow({ width: 480, height: 270 });
      const doc = opened.document;
      doc.title = label;
      const theme = getComputedStyle(document.documentElement);
      const token = (name: string) => theme.getPropertyValue(name).trim();
      Object.assign(doc.body.style, {
        background: token('--bg-container'),
        color: token('--bg-on-container'),
        display: 'grid',
        gridTemplateRows: '1fr auto',
        height: '100vh',
        margin: '0',
      });
      const player = doc.createElement('video');
      player.autoplay = true;
      player.muted = true;
      player.playsInline = true;
      player.style.cssText = 'width:100%;height:100%;object-fit:contain;min-height:0';
      const back = doc.createElement('button');
      back.type = 'button';
      back.textContent = $i18n.t('call.returnToCall');
      Object.assign(back.style, {
        cursor: 'pointer',
        font: 'inherit',
        padding: token('--space-200'),
      });
      on(back, 'click', () => {
        window.focus();
        onReturn();
        opened.close();
      });
      doc.body.append(player, back);
      media.attach(player);
      popped = 'document';
      on(opened, 'pagehide', () => {
        media.detach(player);
        popped = null;
      });
      return;
    }
    if (!video) return;
    await video.requestPictureInPicture();
    popped = 'video';
    const off = on(video, 'leavepictureinpicture', () => {
      popped = null;
      off();
    });
  }

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) {
      return;
    }
    const node = event.currentTarget;
    if (!(node instanceof HTMLElement)) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    const offMove = on(window, 'pointermove', (move: PointerEvent) => {
      const x = move.clientX - startX;
      const y = move.clientY - startY;
      if (!moved && Math.hypot(x, y) < 6) return;
      moved = true;
      drag = { x, y };
    });
    const offUp = on(window, 'pointerup', (up: PointerEvent) => {
      offMove();
      offUp();
      drag = null;
      if (!moved) {
        onReturn();
        return;
      }
      const corner: PreviewCorner = `${up.clientY < window.innerHeight / 2 ? 'top' : 'bottom'}-${
        up.clientX < window.innerWidth / 2 ? 'left' : 'right'
      }`;
      previewCorner.value = corner;
    });
  }
</script>

{#if shown && room && popped !== 'document' && dismissedPreview.key !== shown.key}
  <section
    class="screen-preview {previewCorner.value}"
    class:dragging={drag !== null}
    class:hidden={popped === 'video'}
    aria-label={label}
    style:translate={drag ? `${String(drag.x)}px ${String(drag.y)}px` : undefined}
    onpointerdown={startDrag}
  >
    {#key shown.key}
      <video bind:this={video} autoplay muted playsinline {@attach attach}></video>
    {/key}
    <div class="bar">
      <MonitorIcon aria-hidden="true" weight="fill" />
      <button type="button" class="name" onclick={onReturn}>{label}</button>
      {#if canPopOut()}
        <IconButton
          variant="ghost"
          size="small"
          label={$i18n.t('call.popOutScreen')}
          onclick={() => void popOut().catch(() => undefined)}
        >
          <ArrowSquareOutIcon />
        </IconButton>
      {/if}
      <IconButton
        variant="ghost"
        size="small"
        label={$i18n.t('call.hideScreenPreview')}
        onclick={() => {
          if (shown) dismissedPreview.key = shown.key;
        }}
      >
        <XIcon />
      </IconButton>
    </div>
  </section>
{/if}

<style>
  .screen-preview {
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    cursor: grab;
    display: grid;
    grid-template-rows: auto auto;
    overflow: hidden;
    position: fixed;
    touch-action: none;
    user-select: none;
    width: min(20rem, calc(100vw - var(--space-400) * 2));
    z-index: var(--layer-float);
  }

  .screen-preview.dragging {
    cursor: grabbing;
  }

  .screen-preview.hidden {
    display: none;
  }

  .top-left,
  .top-right {
    top: max(var(--space-400), var(--safe-top));
  }

  .bottom-left,
  .bottom-right {
    bottom: max(var(--space-400), var(--safe-bottom));
  }

  .top-left,
  .bottom-left {
    left: max(var(--space-400), var(--safe-left));
  }

  .top-right,
  .bottom-right {
    right: max(var(--space-400), var(--safe-right));
  }

  video {
    aspect-ratio: 16 / 9;
    background: var(--tile-scrim);
    display: block;
    object-fit: contain;
    pointer-events: none;
    width: 100%;
  }

  .bar {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    gap: var(--space-200);
    padding: var(--space-100) var(--space-200);
  }

  .bar :global(svg) {
    flex: none;
  }

  .name {
    background: transparent;
    border: 0;
    color: inherit;
    cursor: pointer;
    flex: 1;
    font: inherit;
    font-size: var(--font-size-small);
    min-width: 0;
    overflow: hidden;
    padding: 0;
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
