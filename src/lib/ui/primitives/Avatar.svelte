<script lang="ts">
  import { Avatar } from 'bits-ui';
  import type { Snippet } from 'svelte';
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
</script>

<Avatar.Root
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
      onloaded={() => (paintedSrc = src)}
      onfailed={() => (failedSrc = src)}
    />
  {:else if src}
    <Avatar.Image {src} alt="" class="avatar-image" />
  {/if}
  <Avatar.Fallback
    class="avatar-fallback"
    style={plate ? `background: ${plate}; color: var(--surface-container)` : undefined}
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

  :global(.avatar-image .media-image-placeholder) {
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
