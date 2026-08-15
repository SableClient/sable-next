<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  import MediaImage from '$lib/ui/MediaImage.svelte';

  type AvatarSize = 'small' | 'medium' | 'large';
  type AvatarShape = 'person' | 'room';

  type Props = {
    src?: string | null;
    alt?: string;
    initials?: string;
    size?: AvatarSize;
    shape?: AvatarShape;
    color?: string;
    decorative?: boolean;
    class?: ClassValue;
  };

  let {
    src = null,
    alt,
    initials = '?',
    size = 'medium',
    shape = 'person',
    color,
    decorative = alt === undefined,
    class: className = '',
  }: Props = $props();

  let accessibleLabel = $derived(alt ?? initials);
</script>

<span
  class={['sable-avatar', `sable-avatar-${size}`, `sable-avatar-${shape}`, className]}
  style:background={color}
  aria-hidden={decorative ? 'true' : undefined}
  role={decorative || src ? undefined : 'img'}
  aria-label={decorative || src ? undefined : accessibleLabel}
>
  {#if src?.startsWith('mxc://')}
    <MediaImage class="avatar-image" source={src} alt={alt ?? ''} width={96} height={96} />
  {:else if src}
    <img {src} alt={alt ?? ''} />
  {:else}
    <span>{initials}</span>
  {/if}
</span>

<style>
  :global(.sable-avatar) {
    --avatar-size: var(--avatar-size-medium);
    --avatar-radius: var(--radius);

    align-items: center;
    background: var(--sable-primary-container);
    border-radius: var(--avatar-radius);
    color: var(--sable-primary-on-container);
    display: inline-flex;
    flex: 0 0 var(--avatar-size);
    font-size: var(--font-size-medium);
    font-weight: var(--font-weight-bold);
    height: var(--avatar-size);
    justify-content: center;
    overflow: hidden;
    vertical-align: middle;
    width: var(--avatar-size);
  }

  :global(.sable-avatar-small) {
    --avatar-size: var(--avatar-size-small);
    --avatar-radius: 0.3125rem;
  }

  :global(.sable-avatar-large) {
    --avatar-size: var(--avatar-size-large);

    font-size: var(--font-size-xlarge);
  }

  :global(.sable-avatar-room) {
    --avatar-radius: var(--radius-pill);
  }

  :global(.sable-avatar img) {
    height: 100%;
    object-fit: cover;
    width: 100%;
  }

  :global(.sable-avatar .avatar-image) {
    height: 100%;
    object-fit: cover;
    width: 100%;
  }
</style>
