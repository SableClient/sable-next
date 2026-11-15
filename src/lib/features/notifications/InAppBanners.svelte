<script lang="ts">
  import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
  import { on } from 'svelte/events';

  import { i18n } from '#lib/i18n.js';

  import InAppBanner from './InAppBanner.svelte';
  import { useNotificationCenter } from './notifications.svelte';

  const notifications = useNotificationCenter();

  let expandRequested = $state(false);
  let keyboardShift = $state(0);

  let items = $derived(notifications.banners.items);
  let replyingIn = $state<string | null>(null);
  let announced = $derived(notifications.banners.announced);
  let hiddenMentions = $derived(items.slice(1).filter((item) => item.mention).length);
  let expanded = $derived(
    (expandRequested || items.some((item) => item.roomId === replyingIn)) && items.length > 1
  );

  // iOS scrolls fixed elements off the top when the keyboard pushes the visual viewport down.
  $effect(() => {
    const viewport = globalThis.visualViewport;
    if (!viewport) return;
    const update = () => {
      keyboardShift = Math.max(0, Math.round(viewport.offsetTop));
    };
    update();
    const offs = [on(viewport, 'resize', update), on(viewport, 'scroll', update)];
    return () => {
      for (const off of offs) off();
    };
  });
</script>

<section
  class={['banners', { expanded }]}
  style:--keyboard-shift="{keyboardShift}px"
  aria-label={i18n.t('banner.region')}
>
  {#each items as banner, index (banner.roomId)}
    <InAppBanner
      {banner}
      depth={expanded ? 0 : index}
      behind={!expanded && index === 0 ? items.length - 1 : 0}
      behindMentions={hiddenMentions}
      onopen={() => {
        notifications.openBanner(banner);
      }}
      ondismiss={() => {
        notifications.banners.dismiss(banner.roomId);
        if (notifications.banners.items.length <= 1) expandRequested = false;
      }}
      onexpand={() => (expandRequested = true)}
      onreply={(text) => notifications.replyToBanner(banner, text)}
      onengage={({ held, replying }) => {
        if (held) notifications.banners.hold(banner.roomId);
        else notifications.banners.release(banner.roomId);
        if (replying) replyingIn = banner.roomId;
        else if (replyingIn === banner.roomId) replyingIn = null;
      }}
    />
  {/each}
  {#if expanded}
    <div class="stack-actions">
      <button type="button" onclick={() => (expandRequested = false)}>
        {i18n.t('banner.showLess')}
        <CaretUpIcon />
      </button>
      <button
        type="button"
        onclick={() => {
          expandRequested = false;
          notifications.banners.dismissAll();
        }}
      >
        {i18n.t('banner.dismissAll')}
      </button>
    </div>
  {/if}
</section>

<p class="screen-reader-only" aria-live="polite">
  {#if announced}
    {#key announced.revision}
      <span>
        {i18n.t(announced.mention ? 'banner.announceMention' : 'banner.announce', {
          room: announced.title,
          message: announced.body,
        })}
      </span>
    {/key}
  {/if}
</p>

<style>
  .banners {
    display: grid;
    inset-inline: calc(var(--space-300) + var(--safe-left))
      calc(var(--space-300) + var(--safe-right));
    margin-inline: auto;
    max-width: 28rem;
    pointer-events: none;
    position: fixed;
    top: calc(var(--safe-top) + var(--space-300) + var(--keyboard-shift));
    z-index: var(--layer-notify);
  }

  .banners.expanded {
    gap: var(--space-200);
    max-height: calc(60dvh - var(--keyboard-shift));
    overflow-y: auto;
    overscroll-behavior: contain;
    pointer-events: auto;
  }

  .banners.expanded > :global(.banner) {
    touch-action: pan-y;
  }

  .stack-actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }

  .stack-actions button {
    align-items: center;
    background: var(--surface-container-hover);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radii-pill);
    box-shadow: var(--shadow-e200);
    color: var(--surface-on-container);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: var(--space-150) var(--space-300);
  }

  .stack-actions button:hover {
    background: var(--surface-container-active);
  }

  @media (pointer: coarse) {
    .stack-actions button {
      min-height: 2.75rem;
    }
  }

  .banners:not(.expanded) > :global(*) {
    grid-area: 1 / 1;
  }

  @media (--app-layout) {
    .banners {
      inset-inline: auto calc(var(--space-400) + var(--safe-right));
      margin-inline: 0;
      width: min(26rem, calc(100vw - var(--space-400) * 2 - var(--safe-left) - var(--safe-right)));
    }
  }
</style>
