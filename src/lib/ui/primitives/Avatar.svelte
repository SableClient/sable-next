<script lang="ts">
  import { Avatar } from 'bits-ui';
  import type { ClassValue } from 'svelte/elements';

  import MediaImage from '#lib/ui/MediaImage.svelte';

  import { toInitials } from './initials.js';

  type AvatarSize = 'small' | 'medium' | 'large';
  type Props = {
    src?: string | null;
    alt?: string;
    name?: string | null;
    initials?: string;
    size?: AvatarSize;
    color?: string;
    decorative?: boolean;
    uniform?: boolean;
    class?: ClassValue;
  };

  let {
    src = null,
    alt,
    name,
    initials,
    size = 'medium',
    color,
    decorative = alt === undefined,
    uniform = false,
    class: className = '',
  }: Props = $props();

  let fallback = $derived(initials ?? toInitials(name));
  let accessibleLabel = $derived(alt ?? name ?? fallback);
  let isMxc = $derived(src?.startsWith('mxc://') ?? false);
  let loadingStatus = $derived<Avatar.RootProps['loadingStatus']>(isMxc ? 'loaded' : 'loading');
</script>

<Avatar.Root
  bind:loadingStatus
  class={['sable-avatar', `sable-avatar-${size}`, className]}
  style={color ? `background: ${color}` : undefined}
  aria-hidden={decorative ? 'true' : undefined}
  role={decorative ? undefined : 'img'}
  aria-label={decorative ? undefined : accessibleLabel}
>
  {#if isMxc && src}
    <MediaImage
      class="sable-avatar-image"
      source={src}
      alt=""
      width={96}
      height={96}
      {uniform}
      onfailed={() => (loadingStatus = 'error')}
    />
  {:else if src}
    <Avatar.Image {src} alt="" class="sable-avatar-image" />
  {/if}
  <Avatar.Fallback class="sable-avatar-fallback">{fallback}</Avatar.Fallback>
</Avatar.Root>

<style>
  :global(.sable-avatar) {
    --avatar-size: var(--avatar-size-400);

    align-items: center;
    background: transparent;
    border-radius: var(--radii-400);
    color: var(--sable-primary-on-container);
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

  :global(.sable-avatar-small) {
    --avatar-size: var(--avatar-size-300);

    font-size: var(--font-size-small);
  }

  :global(.sable-avatar-large) {
    --avatar-size: var(--avatar-size-500);

    font-size: var(--font-size-display);
  }

  :global(.sable-avatar-image),
  :global(.sable-avatar-fallback) {
    border-radius: inherit;
    height: 100%;
    inset: 0;
    position: absolute;
    width: 100%;
  }

  :global(.sable-avatar-image) {
    object-fit: cover;
    object-position: center;
  }

  :global(.sable-avatar-fallback) {
    align-items: center;
    display: flex;
    justify-content: center;
  }
</style>
