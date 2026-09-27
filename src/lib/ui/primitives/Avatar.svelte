<script lang="ts" module>
  const HOVER_SCOPE = 'article, li, [role="option"], [role="row"]';
</script>

<script lang="ts">
  import { Avatar } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import { on } from 'svelte/events';
  import type { ClassValue } from 'svelte/elements';

  import MediaImage from '#lib/ui/MediaImage.svelte';

  import { identityColor } from './identity-color.js';
  import { toInitials } from './initials.js';

  type AvatarSize = 'small' | 'medium' | 'large';
  type Props = {
    src?: string | null;
    alt?: string;
    id?: string | null;
    name?: string | null;
    initials?: string;
    size?: AvatarSize;
    color?: string;
    decorative?: boolean;
    uniform?: boolean;
    original?: boolean;
    class?: ClassValue;
    children?: Snippet;
  };

  let {
    src = null,
    alt,
    id = null,
    name,
    initials,
    size = 'medium',
    color,
    decorative = alt === undefined,
    uniform = false,
    original = false,
    class: className = '',
    children,
  }: Props = $props();

  let fallback = $derived(initials ?? toInitials(name));
  let accessibleLabel = $derived(alt ?? name ?? fallback);
  let isMxc = $derived(src?.startsWith('mxc://') ?? false);
  let imageStatus = $state<Avatar.RootProps['loadingStatus']>('loading');
  let paintedSrc = $state<string | null>(null);
  let failedSrc = $state<string | null>(null);
  let loadingStatus = $derived<Avatar.RootProps['loadingStatus']>(
    !src ? 'error' : isMxc ? (failedSrc === src ? 'error' : 'loaded') : imageStatus
  );
  let plate = $derived(color ?? (id === null ? undefined : identityColor(id)));
  let tint = $derived(paintedSrc === src ? undefined : plate);
  let hovered = $state(false);

  function playOnHover(node: HTMLElement): () => void {
    const scope = node.closest<HTMLElement>(HOVER_SCOPE) ?? node;
    const stopEnter = on(scope, 'pointerenter', (event) => {
      if (event.pointerType === 'mouse') hovered = true;
    });
    const stopLeave = on(scope, 'pointerleave', () => {
      hovered = false;
    });
    return () => {
      stopEnter();
      stopLeave();
    };
  }
</script>

<Avatar.Root
  {@attach isMxc && !original ? playOnHover : undefined}
  bind:loadingStatus={() => loadingStatus, (value) => (imageStatus = value)}
  class={['avatar-root', `avatar-${size}`, className]}
  aria-hidden={decorative ? 'true' : undefined}
  role={decorative ? undefined : 'img'}
  aria-label={decorative ? undefined : accessibleLabel}
>
  {#if isMxc && src}
    <MediaImage
      class="avatar-image"
      style={tint ? `background: ${tint}` : undefined}
      source={src}
      alt=""
      width={96}
      height={96}
      {uniform}
      {original}
      onloaded={() => {
        paintedSrc = src;
        failedSrc = null;
      }}
      onfailed={() => (failedSrc = src)}
    />
    {#if hovered && !original}
      <MediaImage class="avatar-image" source={src} alt="" width={96} height={96} original />
    {/if}
  {:else if src}
    <Avatar.Image {src} alt="" class="avatar-image" />
  {/if}
  <Avatar.Fallback
    class="avatar-fallback"
    style={plate ? `background: ${plate}; color: var(--avatar-identity-on-plate)` : undefined}
  >
    {#if children}{@render children()}{:else}{fallback}{/if}
  </Avatar.Fallback>
</Avatar.Root>

<style>
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

  :global(.avatar-image .media-image-placeholder),
  :global(.avatar-image .media-image-unavailable) {
    display: none;
  }

  :global(.avatar-fallback) {
    align-items: center;
    background: var(--sec-container);
    color: var(--sec-on-container);
    display: flex;
    justify-content: center;
    text-transform: capitalize;
  }
</style>
