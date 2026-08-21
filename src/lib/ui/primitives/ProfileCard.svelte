<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  import MediaImage from '#lib/ui/MediaImage.svelte';

  import Avatar from './Avatar.svelte';

  interface Props {
    displayName: string;
    userId: string;
    avatarUrl?: string | null;
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
    bioMoreLabel?: string;
    bioLessLabel?: string;
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
    color,
    heroColor = null,
    heroBrightness = null,
    bannerUrl = null,
    status = null,
    statusEmoji = null,
    nameColorLight = null,
    nameColorDark = null,
    bioMoreLabel,
    bioLessLabel,
    variant = 'popover',
    class: className = '',
    meta,
    actions,
    children,
    footer,
    composer,
  }: Props = $props();
  let initials = $derived(displayName.slice(0, 1).toUpperCase() || '?');
  let banner = $derived(bannerUrl?.startsWith('mxc://') ? bannerUrl : null);
  let tinted = $derived(heroColor !== null && heroColor !== '');
  let nameColor = $derived(nameColorLight ?? nameColorDark);
  let nameColorForDark = $derived(nameColorDark ?? nameColorLight);
  let clampable = $derived(Boolean(bioMoreLabel && bioLessLabel));
  let expanded = $state(false);
  let truncated = $state(false);
  const uid = $props.id();

  // The bio arrives with the profile fetch, so the overflow check has to outlive
  // the first render.
  function measureOverflow(node: HTMLElement): (() => void) | undefined {
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (!expanded) truncated = node.scrollHeight > node.clientHeight + 1;
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }
</script>

<section
  class={['sable-profile-card', `sable-profile-card-${variant}`, className]}
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
    <Avatar
      class="profile-card-avatar"
      size="large"
      src={avatarUrl}
      {initials}
      {color}
      alt={displayName}
    />
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
          <div
            id="{uid}-bio"
            class="profile-card-bio"
            class:clamped={clampable && !expanded}
            {@attach measureOverflow}
          >
            {@render children()}
          </div>
          {#if clampable && (truncated || expanded)}
            <button
              class="profile-card-bio-toggle"
              type="button"
              aria-expanded={expanded}
              aria-controls="{uid}-bio"
              onclick={() => (expanded = !expanded)}
            >
              {expanded ? bioLessLabel : bioMoreLabel}
            </button>
          {/if}
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
  .sable-profile-card {
    /* --sable-sec-main alone fails 4.5:1 on the light background at this text
       size, so small words get a stronger mix and it is left to icons. */
    --profile-text-muted: color-mix(
      in oklab,
      var(--sable-sec-main) 55%,
      var(--sable-bg-on-container)
    );
    --profile-avatar-size: var(--avatar-size-large);
    --profile-cover-height: var(--avatar-size-large);
    --profile-bio-lines: 4;
    --profile-card-ground: var(--sable-bg-container);
    --profile-panel-ground: var(--sable-surface-container);

    background: var(--profile-card-ground);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    overflow: hidden;
    position: relative;
  }

  .sable-profile-card.tinted {
    --profile-tint: 20%;
    --profile-card-ground: color-mix(
      in oklab,
      var(--profile-hero) var(--profile-tint),
      var(--sable-bg-container)
    );
    --profile-panel-ground: color-mix(
      in oklab,
      var(--profile-hero) var(--profile-tint),
      var(--sable-surface-container)
    );
  }

  .sable-profile-card.tinted.tint-dark {
    --profile-tint: 30%;
  }

  .sable-profile-card.tinted.tint-light {
    --profile-tint: 12%;
  }

  .profile-card-cover {
    height: var(--profile-cover-height);
  }

  .sable-profile-card-sheet {
    --profile-cover-height: 6rem;
    --profile-bio-lines: 6;
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
    gap: var(--space-2);
    margin-top: calc(var(--profile-avatar-size) / -2);
    padding: 0 var(--space-3);
    position: relative;
  }

  .profile-card-crest :global(.sable-avatar.profile-card-avatar) {
    --avatar-size: var(--profile-avatar-size);

    box-shadow: 0 0 0 0.25rem var(--profile-card-ground);
  }

  /* Rounded like the bio panel, not pill like the action row: this is something
     the owner wrote, not a control. */
  .profile-card-status {
    background: var(--profile-panel-ground);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    -webkit-box-orient: vertical;
    display: -webkit-box;
    font-size: var(--font-size-body);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    line-height: var(--line-height-body);
    margin: 0 0 var(--space-1);
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    padding: var(--space-1) var(--space-2);
  }

  .profile-card-status-emoji {
    font-size: var(--font-size-medium);
    margin-right: 0.375rem;
  }

  .profile-card-identity {
    padding: var(--space-2) var(--space-3) var(--space-3);
  }

  .profile-card-name,
  .profile-card-user-id {
    margin: 0;
  }

  .profile-card-name {
    font-size: var(--font-size-large);
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
    margin-top: 0.125rem;
    overflow-wrap: anywhere;
  }

  /* Items sit next to each other and wrap. Equal grid columns left a short fact
     like "she/her" stranded half a card away from the next one. */
  .profile-card-meta {
    color: var(--profile-text-muted);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-1) var(--space-2);
    line-height: var(--line-height-body);
    margin-top: var(--space-2);
  }

  .profile-card-meta :global(svg) {
    color: var(--sable-sec-main);
    flex: none;
  }

  /* Same gutter as the identity text, and framed only with a bio to hold: a lone
     misc-data line in a panel reads as an empty box. */
  .profile-card-panel {
    margin: 0 var(--space-3) var(--space-2);
  }

  /* Padding sits on the rows, not here, so the divider between them can reach
     both edges of the panel. */
  .profile-card-panel.framed {
    background: var(--profile-panel-ground);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    overflow: clip;
  }

  .profile-card-bio-block {
    display: grid;
    padding: var(--space-2);
  }

  /* One toolbar of equal targets, which is what separates verbs from the facts
     above rather than the presence of a border. */
  .profile-card-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: var(--space-2);
  }

  .profile-card-bio {
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    overflow-wrap: break-word;
  }

  .profile-card-bio.clamped {
    -webkit-box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: var(--profile-bio-lines);
    line-clamp: var(--profile-bio-lines);
    overflow: hidden;
  }

  .profile-card-bio :global(.formatted-body) {
    white-space: normal;
  }

  /* A link, so it keeps an underline instead of a button's shape. */
  .profile-card-bio-toggle {
    background: none;
    border: 0;
    color: var(--sable-primary-main);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    justify-self: start;
    margin: var(--space-1) 0 0;
    padding: 0;
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }

  .profile-card-bio-toggle:hover {
    text-decoration-thickness: 2px;
  }

  .sable-profile-card-sheet .profile-card-bio-toggle {
    align-items: center;
    display: inline-flex;
    min-height: 2.75rem;
  }

  .profile-card-bio-toggle:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* No hairline: the framed panel above already draws one edge, and two reads as
     a double rule. */
  .profile-card-composer {
    padding: 0 var(--space-3) var(--space-3);
  }

  .profile-card-footer.divided {
    border-top: var(--border-width) solid var(--sable-surface-container-line);
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
