<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  import MediaImage from '$lib/ui/MediaImage.svelte';

  import Avatar from './Avatar.svelte';

  interface Props {
    displayName: string;
    userId: string;
    avatarUrl?: string | null;
    color: string;
    /** Chosen by the profile's owner, unlike `color`, so this is what may tint
        the whole card rather than only the banner. */
    heroColor?: string | null;
    heroBrightness?: 'light' | 'dark' | null;
    bannerUrl?: string | null;
    status?: string | null;
    statusEmoji?: string | null;
    /** Arbitrary user-chosen colours, so each theme gets its own or none. */
    nameColorLight?: string | null;
    nameColorDark?: string | null;
    /** Without both labels the bio stays fully expanded: a clamp with no way to
        undo it would hide text for good. */
    bioMoreLabel?: string;
    bioLessLabel?: string;
    /** A sheet is read at arm's length: taller banner, bigger targets, and the
        bio clamp relaxes because there is room for it. */
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
  // The fallback colour is derived from the user id, which is not a choice the
  // owner made, so only a real hero colour is allowed to tint the surfaces.
  let tinted = $derived(heroColor !== null && heroColor !== '');
  // Each theme falls back to the other rather than to the theme's text colour:
  // a name written for one theme still beats an untinted name.
  let nameColor = $derived(nameColorLight ?? nameColorDark);
  let nameColorForDark = $derived(nameColorDark ?? nameColorLight);
  let clampable = $derived(Boolean(bioMoreLabel && bioLessLabel));
  let bioNode = $state<HTMLElement | null>(null);
  let expanded = $state(false);
  let truncated = $state(false);

  // The bio arrives with the profile fetch, so the overflow check has to outlive
  // the first render.
  $effect(() => {
    const node = bioNode;
    if (!node || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      if (!expanded) truncated = node.scrollHeight > node.clientHeight + 1;
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  });
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
      <MediaImage class="profile-card-banner" source={banner} alt="" width={352} height={72} />
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
        <div bind:this={bioNode} class="profile-card-bio" class:clamped={clampable && !expanded}>
          {@render children()}
        </div>
        {#if clampable && (truncated || expanded)}
          <button
            class="profile-card-bio-toggle"
            type="button"
            onclick={() => (expanded = !expanded)}
          >
            {expanded ? bioLessLabel : bioMoreLabel}
          </button>
        {/if}
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
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius-card);
    overflow: hidden;
    position: relative;
  }

  /* The owner's colour tints every surface, mixed into the theme's own so the
     text keeps the contrast it was designed against. A colour the writer meant
     as a dark surface takes a thicker mix than one meant as light, which in the
     dark theme would wash the card out. */
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

  /* Matches the avatar diameter, so the avatar's centre lands on the banner edge. */
  .profile-card-cover {
    height: var(--profile-cover-height);
  }

  /* The sheet's banner is its header, so it earns the extra height. */
  .sable-profile-card-sheet {
    --profile-cover-height: 6rem;
    --profile-bio-lines: 6;
  }

  .profile-card-cover :global(.profile-card-banner) {
    height: 100%;
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

  /* Ring as a shadow, not a border: the avatar keeps its declared size and
     punches a hole in the banner. It bleeds outside the text gutter on purpose,
     so the avatar's glyph edge lines up with the name. */
  :global(.sable-avatar.profile-card-avatar) {
    --avatar-size: var(--profile-avatar-size);

    box-shadow: 0 0 0 0.25rem var(--profile-card-ground);
  }

  /* A pill rather than a speech bubble: a tail fights the avatar ring, and the
     fill is what keeps a wrapped status legible over an arbitrary banner. */
  .profile-card-status {
    background: var(--profile-panel-ground);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius-pill);
    -webkit-box-orient: vertical;
    display: -webkit-box;
    font-size: var(--font-size-small);
    -webkit-line-clamp: 2;
    line-clamp: 2;
    margin: 0 0 var(--space-1);
    min-width: 0;
    overflow: hidden;
    overflow-wrap: anywhere;
    padding: 0.125rem var(--space-1);
  }

  .profile-card-status-emoji {
    margin-right: 0.25rem;
  }

  /* No fill of its own: the bare card ground under the identity is what
     separates it from the panel below, in place of a divider. */
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

  /* The identity anchor stays neutral: if the name is a colour the user picked,
     the ID has to be the part you can trust. */
  .profile-card-user-id {
    color: var(--profile-text-muted);
    font-size: var(--font-size-small);
    margin-top: 0.125rem;
    overflow-wrap: anywhere;
  }

  /* Column gap has to beat the icon-to-label gap inside an item, or wrapped
     items read as one sentence. */
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

  /* Only framed when there is a bio to hold: a lone misc-data line inside a
     panel reads as an empty box with a label in it. */
  .profile-card-panel {
    margin: 0 var(--space-2) var(--space-1);
  }

  /* --radius, not --radius-card: a nested box sharing the parent radius looks
     unseated. */
  .profile-card-panel.framed {
    background: var(--profile-panel-ground);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    margin: 0 var(--space-1) var(--space-1);
    padding: var(--space-2);
  }

  .profile-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }

  .profile-card-bio {
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
    overflow-wrap: break-word;
  }

  /* Clamped rather than scrolled: a scroll area in a popover steals the wheel
     from the timeline underneath and hides how much is left. */
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

  .profile-card-bio-toggle {
    background: none;
    border: 0;
    border-radius: var(--radius-pill);
    color: var(--sable-primary-main);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    margin: var(--space-1) 0 0 -0.5rem;
    padding: 0.125rem var(--space-1);
  }

  /* Hover moves the background, never the foreground, so contrast can only rise. */
  .profile-card-bio-toggle:hover {
    background: color-mix(in oklab, var(--sable-primary-main) 14%, var(--profile-panel-ground));
  }

  /* Touch target, not decoration. */
  .sable-profile-card-sheet .profile-card-bio-toggle {
    align-items: center;
    display: inline-flex;
    min-height: 2.75rem;
  }

  .profile-card-bio-toggle:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Card ground and a hairline, not the panel surface, so it reads as card
     furniture rather than something the profile's owner wrote. */
  .profile-card-composer {
    border-top: 1px solid var(--sable-bg-container-line);
    padding: var(--space-2);
  }

  .sable-profile-card-sheet .profile-card-composer {
    padding: var(--space-2) var(--space-3) var(--space-3);
  }

  /* Same box as the bio: it is metadata about the same person. */
  .profile-card-footer.divided {
    border-top: 1px solid var(--sable-surface-container-line);
    margin-top: var(--space-2);
    padding-top: var(--space-1);
  }

  @media (prefers-color-scheme: dark) {
    .profile-card-name.tinted {
      color: var(--profile-name-color-dark);
    }
  }

  /* Keeping the hue but clamping lightness and chroma leaves the user's choice
     recognisable while guaranteeing contrast, where blending toward the
     background would mute it and could still fail. */
  @supports (color: oklch(from red l c h)) {
    .profile-card-name.tinted {
      color: oklch(from var(--profile-name-color) clamp(0.25, l, 0.52) clamp(0, c, 0.19) h);
    }

    @media (prefers-color-scheme: dark) {
      .profile-card-name.tinted {
        color: oklch(from var(--profile-name-color-dark) clamp(0.72, l, 0.92) clamp(0, c, 0.16) h);
      }
    }
  }
</style>
