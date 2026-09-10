<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  import MediaImage from '#lib/ui/MediaImage.svelte';

  import Avatar from './Avatar.svelte';

  interface Props {
    displayName: string;
    userId: string;
    avatarUrl?: string | null;
    avatarLabel?: string;
    onAvatarClick?: (source: string, displayName: string) => void;
    color: string;
    /** The owner's own choice, so only this one tints the card. `color` also
        covers the id-derived fallback. */
    heroColor?: string | null;
    heroBrightness?: 'light' | 'dark' | null;
    bannerUrl?: string | null;
    status?: string | null;
    statusEmoji?: string | null;
    nameColorLight?: string | null;
    nameColorDark?: string | null;
    variant?: 'popover' | 'sheet';
    class?: ClassValue;
    meta?: Snippet;
    actions?: Snippet;
    children?: Snippet;
    footer?: Snippet;
    composer?: Snippet;
  }

  let {
    displayName,
    userId,
    avatarUrl = null,
    avatarLabel,
    onAvatarClick,
    color,
    heroColor = null,
    heroBrightness = null,
    bannerUrl = null,
    status = null,
    statusEmoji = null,
    nameColorLight = null,
    nameColorDark = null,
    variant = 'popover',
    class: className = '',
    meta,
    actions,
    children,
    footer,
    composer,
  }: Props = $props();
  let banner = $derived(bannerUrl?.startsWith('mxc://') ? bannerUrl : null);
  let tinted = $derived(heroColor !== null && heroColor !== '');
  let nameColor = $derived(nameColorLight ?? nameColorDark);
  let nameColorForDark = $derived(nameColorDark ?? nameColorLight);
  let canOpenAvatar = $derived(Boolean(avatarUrl && onAvatarClick));
  function openAvatar(): void {
    if (avatarUrl) onAvatarClick?.(avatarUrl, displayName);
  }
</script>

<section
  class={['profile-card', `profile-card-${variant}`, className]}
  class:tinted
  class:tint-light={heroBrightness === 'light'}
  class:tint-dark={heroBrightness === 'dark'}
  style:--profile-hero={heroColor}
>
  <div class="profile-card-cover" style:background={color}>
    {#if banner}
      <MediaImage class="profile-card-banner" source={banner} alt="" width={720} height={240} />
    {/if}
  </div>
  <div class="profile-card-crest">
    {#if canOpenAvatar}
      <button
        class="profile-card-avatar-button"
        type="button"
        aria-label={avatarLabel ?? displayName}
        onclick={openAvatar}
      >
        <Avatar
          class="profile-card-avatar"
          size="large"
          src={avatarUrl}
          name={displayName}
          {color}
          decorative
        />
      </button>
    {:else}
      <Avatar
        class="profile-card-avatar"
        size="large"
        src={avatarUrl}
        name={displayName}
        {color}
        alt={displayName}
      />
    {/if}
    {#if status}
      <p class="profile-card-status">
        {#if statusEmoji}<span class="profile-card-status-emoji">{statusEmoji}</span>{/if}{status}
      </p>
    {/if}
  </div>
  <div class="profile-card-identity">
    <h2
      class="profile-card-name"
      class:tinted={nameColor}
      style:--profile-name-color={nameColor}
      style:--profile-name-color-dark={nameColorForDark}
    >
      {displayName}
    </h2>
    <p class="profile-card-user-id">{userId}</p>
    {#if meta}
      <div class="profile-card-meta">{@render meta()}</div>
    {/if}
    {#if actions}
      <div class="profile-card-actions">{@render actions()}</div>
    {/if}
  </div>
  {#if children || footer}
    <div class="profile-card-panel" class:framed={children}>
      {#if children}
        <div class="profile-card-bio-block">
          <div class="profile-card-bio">{@render children()}</div>
        </div>
      {/if}
      {#if footer}
        <div class="profile-card-footer" class:divided={children}>{@render footer()}</div>
      {/if}
    </div>
  {/if}
  {#if composer}
    <div class="profile-card-composer">{@render composer()}</div>
  {/if}
</section>

<style>
  .profile-card {
    /* --sec-main alone fails 4.5:1 on the light background at this text
       size, so small words get a stronger mix and it is left to icons. */
    --profile-text-muted: color-mix(in oklab, var(--sec-main) 55%, var(--bg-on-container));
    --profile-avatar-size: var(--avatar-size-large);
    --profile-cover-height: var(--avatar-size-large);
    --profile-card-ground: var(--bg-container);
    --profile-panel-ground: var(--surface-container);

    background: var(--profile-card-ground);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    overflow: hidden;
    position: relative;
  }

  .profile-card.tinted {
    --profile-tint: 20%;
    --profile-card-ground: color-mix(
      in oklab,
      var(--profile-hero) var(--profile-tint),
      var(--bg-container)
    );
    --profile-panel-ground: color-mix(
      in oklab,
      var(--profile-hero) var(--profile-tint),
      var(--surface-container)
    );
  }

  .profile-card.tinted.tint-dark {
    --profile-tint: 30%;
  }

  .profile-card.tinted.tint-light {
    --profile-tint: 12%;
  }

  .profile-card-cover {
    height: var(--profile-cover-height);
  }

  .profile-card-sheet {
    --profile-cover-height: 6rem;
  }

  /* Both dimensions, so the ratio MediaImage sets inline stops applying. */
  .profile-card-cover :global(.profile-card-banner) {
    height: 100%;
    width: 100%;
  }

  .profile-card-cover :global(.profile-card-banner img) {
    object-fit: cover;
    object-position: center;
  }

  .profile-card-crest {
    align-items: flex-end;
    display: flex;
    gap: var(--space-300);
    margin-top: calc(var(--profile-avatar-size) / -2);
    padding: 0 var(--space-400);
    position: relative;
  }

  .profile-card-crest :global(.avatar-root.profile-card-avatar) {
    --avatar-size: var(--profile-avatar-size);

    box-shadow: 0 0 0 0.25rem var(--profile-card-ground);
  }

  .profile-card-avatar-button {
    background: none;
    border: 0;
    border-radius: var(--radii-400);
    cursor: pointer;
    display: inline-flex;
    flex: 0 0 var(--profile-avatar-size);
    height: var(--profile-avatar-size);
    padding: 0;
    width: var(--profile-avatar-size);
  }

  .profile-card-avatar-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Rounded like the bio panel, not pill like the action row: this is something
     the owner wrote, not a control. */
  .profile-card-status {
    background: var(--profile-panel-ground);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    -webkit-box-orient: vertical;
    display: -webkit-box;
    font-size: var(--font-size-body);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    line-height: var(--line-height-body);
    margin: 0 0 var(--space-200);
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    padding: var(--space-200) var(--space-300);
  }

  .profile-card-status-emoji {
    font-size: var(--font-size-heading);
    margin-right: var(--space-150);
  }

  .profile-card-identity {
    padding: var(--space-300) var(--space-400) var(--space-400);
  }

  .profile-card-name,
  .profile-card-user-id {
    margin: 0;
  }

  .profile-card-name {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
  }

  .profile-card-name.tinted {
    color: var(--profile-name-color);
  }

  .profile-card-user-id {
    color: var(--profile-text-muted);
    font-size: var(--font-size-small);
    margin-top: var(--space-050);
    overflow-wrap: anywhere;
  }

  /* Items sit next to each other and wrap. Equal grid columns left a short fact
     like "she/her" stranded half a card away from the next one. */

  .profile-card-meta {
    color: var(--profile-text-muted);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-200) var(--space-300);
    line-height: var(--line-height-small);
    margin-top: var(--space-300);
    opacity: var(--opacity-p400);
  }

  .profile-card-meta :global(svg) {
    flex: none;
    opacity: var(--opacity-placeholder);
  }

  /* Same gutter as the identity text, and framed only with a bio to hold: a lone
     misc-data line in a panel reads as an empty box. */
  .profile-card-panel {
    margin: 0 var(--space-400) var(--space-300);
  }

  /* Padding sits on the rows, not here, so the divider between them can reach
     both edges of the panel. */
  .profile-card-panel.framed {
    background: var(--profile-panel-ground);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    overflow: clip;
  }

  .profile-card-bio-block {
    display: grid;
    padding: var(--space-300);
  }

  /* One toolbar of equal targets, which is what separates verbs from the facts
     above rather than the presence of a border. */
  .profile-card-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
    margin-top: var(--space-300);
  }

  .profile-card-bio {
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    overflow-wrap: break-word;
  }

  .profile-card-bio :global(.formatted-body) {
    white-space: normal;
  }

  /* No hairline: the framed panel above already draws one edge, and two reads as
     a double rule. */
  .profile-card-composer {
    padding: 0 var(--space-400) var(--space-400);
  }

  .profile-card-footer.divided {
    border-top: var(--border-width) solid var(--surface-container-line);
  }

  @media (prefers-color-scheme: dark) {
    :root:not(.light) .profile-card-name.tinted,
    :root.dark .profile-card-name.tinted {
      color: var(--profile-name-color-dark);
    }
  }

  @supports (color: oklch(from red l c h)) {
    .profile-card-name.tinted {
      color: oklch(from var(--profile-name-color) clamp(0.25, l, 0.52) clamp(0, c, 0.19) h);
    }

    @media (prefers-color-scheme: dark) {
      :root:not(.light) .profile-card-name.tinted,
      :root.dark .profile-card-name.tinted {
        color: oklch(from var(--profile-name-color-dark) clamp(0.72, l, 0.92) clamp(0, c, 0.16) h);
      }
    }
  }

  :root.dark .profile-card-name.tinted {
    color: var(--profile-name-color-dark);
  }

  @supports (color: oklch(from red l c h)) {
    :root.dark .profile-card-name.tinted {
      color: oklch(from var(--profile-name-color-dark) clamp(0.72, l, 0.92) clamp(0, c, 0.16) h);
    }
  }
</style>
