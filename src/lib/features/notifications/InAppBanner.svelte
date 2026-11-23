<script lang="ts">
  import ArrowBendUpLeftIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import AtIcon from 'phosphor-svelte/lib/AtIcon';
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import PaperPlaneRightIcon from 'phosphor-svelte/lib/PaperPlaneRightIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { untrack } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import { windowActivity } from '#lib/platform/window-activity.js';
  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import PreviewSegments from '#lib/features/room/messages/PreviewSegments.svelte';

  import type { Banner } from './in-app-banners.svelte';

  type Exit = 'up' | 'left' | 'right';

  let {
    banner,
    depth,
    behind,
    behindMentions,
    onopen,
    ondismiss,
    onexpand,
    onreply,
    onengage,
  }: {
    banner: Banner;
    /** Position in the collapsed stack, 0 in front. */
    depth: number;
    behind: number;
    behindMentions: number;
    onopen: () => void;
    ondismiss: () => void;
    onexpand: () => void;
    onreply: (text: string) => Promise<void>;
    onengage: (state: { held: boolean; replying: boolean }) => void;
  } = $props();

  const DURATION_MS = 6000;
  const TAP_SLOP = 6;
  const SWIPE_UP = 40;

  let card = $state<HTMLElement>();
  let held = $state(false);
  let replying = $state(false);
  let sending = $state(false);
  let draft = $state('');
  let failed = $state(false);
  let drag = $state<{ x: number; y: number; pointer: number; moved: boolean } | null>(null);
  let swallowClick = false;
  let dx = $state(0);
  let dy = $state(0);
  let exit: Exit = 'up';

  let engaged = $derived(held || replying || draft !== '' || drag !== null);
  let paused = $derived(engaged || depth > 0 || !windowActivity.visible);

  // Reports to the stack, which lives outside this component.
  $effect(() => {
    onengage({ held: engaged, replying });
  });

  let elapsed = 0;
  let seen = untrack(() => banner.revision);

  $effect(() => {
    if (banner.revision !== seen) {
      seen = banner.revision;
      elapsed = 0;
    }
    if (paused) return;
    const started = performance.now();
    const timer = setTimeout(() => {
      leave('up');
    }, DURATION_MS - elapsed);
    return () => {
      clearTimeout(timer);
      elapsed += performance.now() - started;
    };
  });

  function leave(direction: Exit): void {
    exit = direction;
    ondismiss();
  }

  function slide(node: Element) {
    const x = exit === 'left' ? -1 : exit === 'right' ? 1 : 0;
    const rise = x === 0 ? node.getBoundingClientRect().bottom : 0;
    const from = { x: dx, y: dy };
    return {
      duration: motionMs(MOTION_MS.medium),
      css: (t: number, u: number) =>
        `opacity: ${t}; transform: translate(calc(${from.x}px + ${x * u * 100}%), ${from.y - u * rise}px);`,
    };
  }

  function enter(node: Element) {
    const rise = node.getBoundingClientRect().bottom;
    return {
      duration: motionMs(MOTION_MS.slow),
      css: (t: number, u: number) => `opacity: ${t}; transform: translateY(${-u * rise}px);`,
    };
  }

  function pointerdown(event: PointerEvent): void {
    swallowClick = false;
    if (depth > 0 || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('.actions, .reply, .more')) return;
    drag = { x: event.clientX, y: event.clientY, pointer: event.pointerId, moved: false };
  }

  function pointermove(event: PointerEvent): void {
    if (drag?.pointer !== event.pointerId) return;
    const x = event.clientX - drag.x;
    const y = event.clientY - drag.y;
    if (!drag.moved) {
      if (Math.hypot(x, y) < TAP_SLOP) return;
      // Capturing only once it drags leaves a plain tap to the open button.
      drag.moved = true;
      card?.setPointerCapture(event.pointerId);
    }
    dx = x;
    dy = Math.min(0, y);
  }

  function pointerup(event: PointerEvent): void {
    if (drag?.pointer !== event.pointerId) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    swallowClick = true;
    const width = card?.offsetWidth ?? 320;
    if (Math.abs(dx) > Math.min(120, width * 0.35)) {
      leave(dx > 0 ? 'right' : 'left');
      return;
    }
    if (dy < -SWIPE_UP && Math.abs(dy) > Math.abs(dx)) {
      leave('up');
      return;
    }
    dx = 0;
    dy = 0;
  }

  function open(): void {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    onopen();
  }

  function pointercancel(): void {
    drag = null;
    dx = 0;
    dy = 0;
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !replying) leave('up');
  }

  async function send(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const text = draft.trim();
    if (text === '' || sending) return;
    sending = true;
    failed = false;
    try {
      await onreply(text);
      draft = '';
      replying = false;
    } catch (error) {
      console.warn('[sable notifications] banner reply failed', error);
      failed = true;
    } finally {
      sending = false;
    }
  }

  function focusOnMount(node: HTMLElement): void {
    node.querySelector('input')?.focus();
  }
</script>

<div
  bind:this={card}
  class={['banner', { stacked: depth > 0, dragging: drag !== null, mention: banner.mention }]}
  style:--depth={depth}
  style:--dx="{dx}px"
  style:--dy="{dy}px"
  role="group"
  aria-label={banner.title}
  aria-hidden={depth > 0 ? 'true' : undefined}
  inert={depth > 0}
  in:enter
  out:slide
  onpointerenter={() => (held = true)}
  onpointerleave={() => (held = false)}
  onfocusin={() => (held = true)}
  onfocusout={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) held = false;
  }}
  onpointerdown={pointerdown}
  onpointermove={pointermove}
  onpointerup={pointerup}
  onpointercancel={pointercancel}
  onkeydown={keydown}
>
  <div class="row">
    <button type="button" class="open" onclick={open}>
      <span class="face">
        <Avatar src={banner.avatar} id={banner.roomId} name={banner.title} size="small" />
        {#if banner.mention}
          <span class="mark" role="img" aria-label={i18n.t('banner.mention')}
            ><AtIcon weight="bold" /></span
          >
        {/if}
      </span>
      <span class="text">
        <span class="title">
          <span class="name">{banner.title}</span>
          {#if banner.count > 1}
            <span class="count">{i18n.t('banner.new', { count: banner.count })}</span>
          {/if}
        </span>
        <span class="body"><PreviewSegments segments={banner.segments} /></span>
      </span>
    </button>
    <div class="actions">
      <IconButton
        size="small"
        variant="ghost"
        label={i18n.t('banner.reply')}
        aria-expanded={replying}
        onclick={() => {
          replying = !replying;
          failed = false;
        }}
      >
        <ArrowBendUpLeftIcon />
      </IconButton>
      <IconButton
        size="small"
        variant="ghost"
        label={i18n.t('common.dismiss')}
        onclick={() => {
          leave('up');
        }}
      >
        <XIcon />
      </IconButton>
    </div>
  </div>

  {#if replying}
    <form class="reply" onsubmit={send} {@attach focusOnMount}>
      <TextInput
        bind:value={draft}
        aria-label={i18n.t('banner.replyTo', { name: banner.title })}
        placeholder={i18n.t('banner.replyTo', { name: banner.title })}
        enterkeyhint="send"
        disabled={sending}
        onkeydown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            replying = false;
            failed = false;
          }
        }}
      />
      <IconButton
        type="submit"
        size="small"
        variant="primary"
        label={i18n.t('banner.send')}
        disabled={sending || draft.trim() === ''}
      >
        <PaperPlaneRightIcon />
      </IconButton>
    </form>
    {#if failed}
      <p class="reply-error" role="alert">{i18n.t('banner.replyFailed')}</p>
    {/if}
  {/if}

  {#if behind > 0}
    <button type="button" class="more" onclick={onexpand}>
      {i18n.t('banner.more', { count: behind })}
      {#if behindMentions > 0}
        · {i18n.t('banner.hiddenMentions', { count: behindMentions })}
      {/if}
      <CaretDownIcon />
    </button>
  {/if}

  {#key banner.revision}
    <div class={['progress', { paused }]} style:animation-duration="{DURATION_MS}ms"></div>
  {/key}
</div>

<style>
  .banner {
    background: var(--surface-container-hover);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-e400);
    color: var(--surface-on-container);
    display: grid;
    gap: var(--space-200);
    overflow: hidden;
    padding: var(--space-300);
    pointer-events: auto;
    position: relative;
    touch-action: none;
    transform: translate(var(--dx), var(--dy));
    user-select: none;
  }

  @media (prefers-reduced-motion: no-preference) {
    .banner {
      transition:
        transform 200ms ease-out,
        opacity 200ms ease-out;
    }
  }

  .banner.mention {
    background:
      linear-gradient(var(--primary-container), var(--primary-container)),
      var(--surface-container-hover);
    border-color: var(--primary-container-line);
    color: var(--primary-on-container);
  }

  .banner.dragging {
    transition: none;
  }

  .banner.stacked {
    background: var(--surface-container);
    box-shadow: var(--shadow-e200);
    pointer-events: none;
    transform: translateY(calc(var(--depth) * var(--space-250)))
      scale(calc(1 - var(--depth) * 0.04));
    transform-origin: bottom center;
    z-index: calc(-1 * var(--depth));
  }

  .banner.stacked > * {
    visibility: hidden;
  }

  .row {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    min-width: 0;
  }

  .open {
    align-items: center;
    background: none;
    border: none;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    font: inherit;
    gap: var(--space-300);
    min-width: 0;
    padding: 0;
    text-align: start;
  }

  .face {
    flex-shrink: 0;
    position: relative;
  }

  .mark {
    align-items: center;
    background: var(--primary-main);
    border: var(--border-width) solid var(--surface-container-hover);
    border-radius: var(--radii-pill);
    bottom: calc(-1 * var(--space-100));
    color: var(--primary-on-main);
    display: flex;
    font-size: var(--font-size-small);
    inset-inline-end: calc(-1 * var(--space-100));
    padding: var(--space-050);
    position: absolute;
  }

  .banner.mention .mark {
    border-color: var(--primary-container);
  }

  .text {
    display: grid;
    flex: 1;
    gap: var(--space-050);
    min-width: 0;
  }

  .title {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    margin: 0;
    min-width: 0;
  }

  .name {
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    color: var(--surface-var-on-container);
    flex-shrink: 0;
    font-size: var(--font-size-small);
  }

  .body {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    margin: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    flex-shrink: 0;
    gap: var(--space-100);
  }

  .reply {
    align-items: center;
    cursor: auto;
    display: flex;
    gap: var(--space-200);
  }

  .reply-error {
    color: var(--crit-main);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .more {
    align-items: center;
    background: none;
    border: none;
    border-top: var(--border-width) solid var(--surface-container-line);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    justify-content: center;
    margin: 0 calc(-1 * var(--space-300)) calc(-1 * var(--space-300));
    padding: var(--space-200);
  }

  .more:hover {
    background: var(--surface-container-active);
  }

  @media (pointer: coarse) {
    .actions :global(.icon-button),
    .reply :global(.icon-button) {
      min-height: 2.75rem;
      min-width: 2.75rem;
    }

    .more {
      min-height: 2.75rem;
    }
  }

  .progress {
    animation-fill-mode: both;
    animation-name: drain;
    animation-timing-function: linear;
    background: var(--primary-main);
    height: 2px;
    inset-inline-start: 0;
    opacity: 0.7;
    position: absolute;
    top: 0;
    width: 100%;
  }

  .progress.paused {
    animation-play-state: paused;
  }

  @keyframes drain {
    from {
      width: 100%;
    }

    to {
      width: 0%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .progress {
      animation-timing-function: steps(6, end);
    }
  }
</style>
