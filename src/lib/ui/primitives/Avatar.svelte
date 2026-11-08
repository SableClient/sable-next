<script lang="ts" module>
  const HOVER_SCOPE = 'article, li, [role="option"], [role="row"]';
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { on } from 'svelte/events';
  import type { ClassValue } from 'svelte/elements';

  import MediaImage from '#lib/ui/MediaImage.svelte';
  import { isAnimatedImage } from '#lib/ui/media-url.js';
  import { animationsPaused, holdStillFrame } from '#lib/ui/still-frame.js';

  import { identityColor } from './identity-color.js';
  import { toInitials } from './initials.js';
  import { mediaViewerState } from '../media/media-viewer-state.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import Tooltip from './Tooltip.svelte';

  type AvatarSize = 'tiny' | 'small' | 'medium' | 'large';
  type Props = {
    src?: string | null;
    openable?: boolean;
    alt?: string;
    id?: string | null;
    name?: string | null;
    initials?: string;
    size?: AvatarSize;
    color?: string;
    decorative?: boolean;
    initialsAsDecoration?: boolean;
    uniform?: boolean;
    recolor?: boolean;
    original?: boolean;
    refreshOnResume?: boolean;
    class?: ClassValue;
    children?: Snippet;
  };

  let {
    src = null,
    openable = false,
    alt,
    id = null,
    name,
    initials,
    size = 'medium',
    color,
    decorative = alt === undefined || openable === true,
    initialsAsDecoration = false,
    uniform = false,
    recolor = false,
    original = false,
    refreshOnResume = false,
    class: className = '',
    children,
  }: Props = $props();

  let fallback = $derived(initials ?? toInitials(name));
  let accessibleLabel = $derived(alt ?? name ?? fallback);
  let isMxc = $derived((src?.startsWith('mxc://') || src?.startsWith('{')) ?? false);
  let paintedSrc = $state<string | null>(null);
  let failedSrc = $state<string | null>(null);
  let pictureShown = $derived(!!src && failedSrc !== src && (isMxc || paintedSrc === src));
  let plate = $derived(color ?? (id === null ? undefined : identityColor(id)));
  let tint = $derived(paintedSrc === src ? undefined : plate);
  let hovered = $state(false);
  let animatedSrc = $state<string | null>(null);
  let overlaySrc = $state<string | null>(null);
  let playing = $derived(hovered && overlaySrc === src && animatedSrc === src);

  async function checkAnimated(source: string, url: string | null): Promise<void> {
    if (!url) return;
    try {
      const blob = await (await fetch(url)).blob();
      const head = await blob.slice(0, 65536).arrayBuffer();
      if (isAnimatedImage(new Uint8Array(head))) animatedSrc = source;
    } catch (error) {
      console.debug('[sable media] the avatar could not be checked for animation', error);
    }
  }

  function playOnHover(node: HTMLElement): () => void {
    const scope = node.closest<HTMLElement>(HOVER_SCOPE) ?? node;
    const stopEnter = on(scope, 'pointerenter', (event) => {
      if (event.pointerType === 'mouse') hovered = true;
    });
    const stopLeave = on(scope, 'pointerleave', () => {
      hovered = false;
      overlaySrc = null;
    });
    return () => {
      stopEnter();
      stopLeave();
    };
  }
</script>

{#snippet avatar()}
  <div
    {@attach playOnHover}
    class={['avatar-root', `avatar-${size}`, className]}
    aria-hidden={decorative ? 'true' : undefined}
    role={decorative ? undefined : 'img'}
    aria-label={decorative ? undefined : accessibleLabel}
  >
    {#if isMxc && src}
      <MediaImage
        class="avatar-image"
        style={playing ? 'opacity: 0' : tint ? `background: ${tint}` : undefined}
        source={src}
        alt=""
        width={96}
        height={96}
        {uniform}
        tint={recolor}
        {original}
        freeze={!original || !hovered}
        autoplay
        {refreshOnResume}
        pixelate={false}
        onloaded={() => {
          paintedSrc = src;
          failedSrc = null;
        }}
        onfailed={(source) => (failedSrc = source)}
      />
      {#if hovered && !original}
        <MediaImage
          class="avatar-image"
          style={playing ? undefined : 'opacity: 0'}
          source={src}
          alt=""
          width={96}
          height={96}
          original
          autoplay
          pixelate={false}
          onloaded={(url) => {
            overlaySrc = src;
            void checkAnimated(src, url);
          }}
        />
      {/if}
    {:else if src}
      <img
        {src}
        alt=""
        class="avatar-image"
        style:display={paintedSrc === src ? undefined : 'none'}
        onload={() => (paintedSrc = src)}
        onerror={() => (failedSrc = src)}
        {@attach (image) => {
          if (paintedSrc === src) holdStillFrame(image, !hovered || animationsPaused());
        }}
      />
    {/if}

    <span
      class="avatar-fallback"
      data-decorative-initials={initialsAsDecoration && !children ? fallback : undefined}
      style={plate ? `background: ${plate}; color: var(--avatar-identity-on-plate)` : undefined}
      style:display={pictureShown ? 'none' : undefined}
    >
      {#if children}{@render children()}{:else if !initialsAsDecoration}{fallback}{/if}
    </span>
  </div>
{/snippet}

{#if openable && src && name}
  {#snippet avatarButtonTrigger({ props: tooltipProps }: { props: Record<string, unknown> })}
    <button
      {...tooltipProps}
      class="avatar-button"
      type="button"
      aria-label={i18n.t('common.viewAvatar', { name })}
      onclick={() => mediaViewerState.openStandalone(src, name)}
    >
      {@render avatar()}
    </button>
  {/snippet}

  <Tooltip label={i18n.t('common.viewAvatar', { name })} trigger={avatarButtonTrigger} />
{:else}
  {@render avatar()}
{/if}

<style>
  :global(.avatar-fallback[data-decorative-initials])::before {
    content: attr(data-decorative-initials);
  }

  :global(.avatar-root) {
    --avatar-size: var(--avatar-size-400);

    align-items: center;
    background: transparent;
    border-radius: var(--radii-400);
    color: var(--primary-on-container);
    display: inline-flex;
    flex: 0 0 var(--avatar-size);
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-600);
    height: var(--avatar-size);
    justify-content: center;
    overflow: hidden;
    position: relative;
    user-select: none;
    vertical-align: middle;
    width: var(--avatar-size);
  }

  :global(.avatar-tiny) {
    --avatar-size: var(--avatar-size-100);

    font-size: var(--font-size-small);
  }

  :global(.avatar-small) {
    --avatar-size: var(--avatar-size-300);

    font-size: var(--font-size-small);
  }

  :global(.avatar-large) {
    --avatar-size: var(--avatar-size-500);

    font-size: var(--font-size-display);
  }

  :global(.avatar-image),
  :global(.avatar-root .media-image.avatar-image),
  :global(.avatar-fallback) {
    border-radius: inherit;
    height: 100%;
    inset: 0;
    position: absolute;
    width: 100%;
  }

  :global(.avatar-image) {
    object-fit: cover;
    object-position: center;
  }

  :global(.avatar-root .media-image.avatar-image) {
    container-type: normal;
  }

  :global(.avatar-image .media-image-placeholder),
  :global(.avatar-image .media-image-unavailable),
  :global(.avatar-image .media-image-progress),
  :global(.avatar-image .media-image-size) {
    display: none;
  }

  :global(.avatar-fallback) {
    align-items: center;
    background: var(--sec-container);
    color: var(--sec-on-container);
    display: flex;
    justify-content: center;
  }

  .avatar-button {
    align-items: center;
    background: none;
    border: 0;
    border-radius: calc(var(--radius) - var(--border-width));
    cursor: pointer;
    height: 100%;
    justify-content: center;
    padding: 0;
    width: 100%;
  }
</style>
