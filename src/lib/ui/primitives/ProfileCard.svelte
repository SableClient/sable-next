<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';
  import type { PresenceView } from '#src/generated/protocol';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import CopySimpleIcon from 'phosphor-svelte/lib/CopySimpleIcon';

  import { i18n } from '#lib/i18n.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import Avatar from './Avatar.svelte';
  import PresenceDot from './PresenceDot.svelte';
  import {
    BLACK,
    WHITE,
    contrastRatio,
    inkFor,
    nameColorOn,
    nameColorOnDark,
    nameColorOnLight,
    profilePalette,
  } from './readable-color.js';

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
    presence?: PresenceView | null;
    presenceLabel?: string;
    nameColorLight?: string | null;
    nameColorDark?: string | null;
    variant?: 'popover' | 'sheet';
    insetBody?: boolean;
    class?: ClassValue;
    meta?: Snippet;
    actions?: Snippet;
    below?: Snippet;
    headerAction?: Snippet;
    crest?: Snippet;
    pronouns?: Snippet;
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
    pronouns,
    heroColor = null,
    heroBrightness = null,
    bannerUrl = null,
    status = null,
    statusEmoji = null,
    presence = null,
    presenceLabel = '',
    nameColorLight = null,
    nameColorDark = null,
    variant = 'popover',
    insetBody = false,
    class: className = '',
    meta,
    actions,
    below,
    headerAction,
    crest,
    children,
    footer,
    composer,
  }: Props = $props();
  let banner = $derived(bannerUrl?.startsWith('mxc://') ? bannerUrl : null);
  let cover = $derived(banner ?? (avatarUrl?.startsWith('mxc://') ? avatarUrl : null));
  let ink = $derived.by(() => {
    if (!heroColor) return null;
    const requested =
      heroBrightness === 'light' ? BLACK : heroBrightness === 'dark' ? WHITE : inkFor(heroColor);
    return contrastRatio(heroColor, requested) >= 4.5 ? requested : inkFor(heroColor);
  });
  let palette = $derived(heroColor && ink ? profilePalette(heroColor, ink) : null);
  let tinted = $derived(palette !== null);
  let nameColor = $derived(nameColorOnLight(nameColorLight ?? nameColorDark));
  let nameColorForDark = $derived(nameColorOnDark(nameColorDark ?? nameColorLight));
  let nameOnHero = $derived.by(() => {
    const own =
      ink === BLACK ? (nameColorLight ?? nameColorDark) : (nameColorDark ?? nameColorLight);
    return palette && own ? nameColorOn(own, palette.ground) : null;
  });
  let canOpenAvatar = $derived(Boolean(avatarUrl && onAvatarClick));
  function openAvatar(): void {
    if (avatarUrl) onAvatarClick?.(avatarUrl, displayName);
  }
  function openBanner(): void {
    if (banner) onAvatarClick?.(banner, displayName);
  }

  const nameId = $props.id();
  let copied = $state(false);
  async function copyUserId(): Promise<void> {
    await navigator.clipboard.writeText(userId);
    copied = true;
    setTimeout(() => {
      copied = false;
    }, 2000);
  }
  function resetStatusScroll(e: { currentTarget: HTMLElement }): void {
    const text = e.currentTarget.querySelector('.profile-card-status-text');
    if (text instanceof HTMLElement && !text.matches(':hover, :focus')) {
      text.scrollTop = 0;
    }
  }
</script>

<section
  aria-labelledby={nameId}
  class={[
    'profile-card',
    `profile-card-${variant}`,
    { 'profile-card-inset-body': insetBody },
    className,
  ]}
  class:tinted
  class:tint-light={ink === BLACK}
  class:tint-dark={ink === WHITE}
  style:--profile-hero={palette?.ground}
  style:--profile-hero-panel={palette?.panel}
  style:--profile-hero-muted={palette?.muted}
  style:--profile-name-color={nameColor}
  style:--profile-name-color-dark={nameColorForDark}
  style:--profile-name-on-hero={nameOnHero}
  data-inset-owner={variant === 'sheet' ? 'bottom' : undefined}
>
  <div class="profile-card-cover" class:has-banner={banner} style:background={color}>
    {#if banner && onAvatarClick}
      <button
        class="profile-card-banner-button"
        type="button"
        aria-label={$i18n.t('timeline.profileBanner', { name: displayName })}
        onclick={openBanner}
      >
        <MediaImage
          class="profile-card-banner"
          source={banner}
          alt=""
          width={720}
          height={240}
          original={preferences.autoplayGifs}
        />
      </button>
    {:else if cover}
      <MediaImage
        class={banner ? 'profile-card-banner' : 'profile-card-banner profile-card-banner-fallback'}
        source={cover}
        alt=""
        width={720}
        height={240}
        original={banner !== null && preferences.autoplayGifs}
      />
    {/if}
  </div>
  <div class="profile-card-crest">
    <div class="profile-card-avatar-wrap">
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
            id={userId}
            color={heroColor ? undefined : color}
            original
            decorative
          />
        </button>
      {:else}
        <Avatar
          class="profile-card-avatar"
          size="large"
          src={avatarUrl}
          name={displayName}
          id={userId}
          color={heroColor ? undefined : color}
          original
          alt={displayName}
        />
      {/if}
      {#if presence}<PresenceDot
          class="profile-card-presence"
          {presence}
          label={presenceLabel}
          size="medium"
        />{/if}
    </div>
    {#if crest}
      <div class="profile-card-crest-content">{@render crest()}</div>
    {:else if status}
      <div
        class="profile-card-status"
        role="group"
        onpointerleave={resetStatusScroll}
        onfocusout={resetStatusScroll}
        data-ui-before
        data-ui-after
      >
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <p
          class="profile-card-status-text explicit-scrollbar"
          role="region"
          aria-label={$i18n.t('settings.status')}
          tabindex="0"
        >
          {#if statusEmoji}<span class="profile-card-status-emoji">{statusEmoji}</span>{/if}{status}
        </p>
      </div>
    {/if}
  </div>
  <div class="profile-card-body">
    <div class="profile-card-identity">
      <div class="profile-card-heading">
        <h2 id={nameId} class="profile-card-name" class:tinted={nameColor}>
          {displayName}
        </h2>
        {#if pronouns}{@render pronouns()}{/if}
        {#if headerAction}{@render headerAction()}{/if}
      </div>
      <button
        class="profile-card-user-id"
        type="button"
        title={$i18n.t(copied ? 'settings.copied' : 'settings.copy')}
        onclick={() => void copyUserId()}
      >
        {userId}
        {#if copied}
          <CheckIcon size="1em" aria-hidden="true" />
        {:else}
          <CopySimpleIcon size="1em" aria-hidden="true" />
        {/if}
      </button>
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
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div
            class="profile-card-bio explicit-scrollbar"
            role="region"
            aria-labelledby={nameId}
            tabindex="0"
          >
            {@render children()}
          </div>
        {/if}
        {#if footer}
          <div class="profile-card-footer" class:divided={children}>{@render footer()}</div>
        {/if}
      </div>
    {/if}
    {#if below}
      <div class="profile-card-below">{@render below()}</div>
    {/if}
    {#if composer}
      <div class="profile-card-composer">{@render composer()}</div>
    {/if}
  </div>
</section>

<style>
  .profile-card {
    /* --sec-main alone fails 4.5:1 on the light background at this text
       size, so small words get a stronger mix and it is left to icons. */
    --profile-text-muted: color-mix(in oklab, var(--sec-main) 55%, var(--surface-on-container));
    --profile-ink: var(--surface-on-container);
    --profile-icon: var(--sec-main);
    --profile-line: var(--surface-container-line);
    --profile-avatar-size: var(--avatar-size-large);
    --profile-cover-height: var(--avatar-size-large);
    --profile-bio-lines: 4;
    --profile-card-ground: var(--surface-container);
    --profile-chip-line: var(--profile-line);
    --pill-size: 1.5rem;
    --pill-padding: var(--space-250);
    --pill-line: var(--profile-chip-line);
    --pill-ink: var(--profile-ink, var(--bg-on-container));
    --pill-icon: var(--profile-icon);
    --pill-state: var(--profile-chip-state);
    --profile-chip-state: var(--bg-on-container);
    --profile-panel-ground: var(--surface-var-container);

    background: var(--profile-card-ground);
    border: var(--border-width) solid var(--profile-line);
    border-radius: var(--radius);
    color: var(--profile-ink);
    overflow: hidden;
    position: relative;
  }

  .profile-card.tinted {
    --profile-ink: var(--bg-on-container);
    --profile-card-ground: var(--profile-hero);
    --profile-panel-ground: var(--profile-hero-panel);
    --profile-text-muted: var(--profile-hero-muted);
    --profile-icon: var(--profile-text-muted);
    --profile-chip-line: color-mix(in oklab, var(--profile-ink) 45%, var(--profile-panel-ground));
    --pill-primary-ground: transparent;
    --pill-primary-ink: var(--profile-ink);
    --pill-primary-line: var(--profile-chip-line);
    --pill-primary-hover: color-mix(in oklab, var(--profile-chip-state) 12%, transparent);
    --profile-line: color-mix(in oklab, var(--profile-ink) 20%, var(--profile-hero));

    color: var(--profile-ink);
  }

  .profile-card.tinted.tint-dark {
    --profile-ink: var(--profile-ink-light);
    --profile-chip-state: var(--profile-ink-dark);
  }

  .profile-card.tinted.tint-light {
    --profile-chip-state: var(--profile-ink-light);
    --profile-ink: var(--profile-ink-dark);
  }

  .profile-card-cover {
    height: var(--profile-cover-height);
    overflow: hidden;
  }

  .profile-card-sheet {
    --profile-cover-height: 6rem;
    --profile-bio-lines: 6;

    padding-bottom: var(--sheet-inset-bottom);
  }

  .profile-card-cover.has-banner {
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

  .profile-card-cover :global(.profile-card-banner-fallback img) {
    filter: blur(1.5rem) saturate(1.2);
    transform: scale(1.4);
  }

  .profile-card-crest {
    align-items: flex-start;
    display: flex;
    gap: var(--space-100);
    min-height: calc(var(--profile-avatar-size) / 2);
    padding: 0 var(--space-200);
    pointer-events: none;
    position: relative;
  }

  .profile-card-crest > :global(*) {
    pointer-events: auto;
  }

  .profile-card-avatar-wrap {
    flex: 0 0 var(--profile-avatar-size);
    margin-bottom: calc(var(--profile-avatar-size) / -2);
    position: relative;
    transform: translateY(-50%);
  }

  .profile-card-crest-content {
    min-width: 0;
    transform: translateY(-50%);
  }

  .profile-card-avatar-wrap :global(.avatar-root.profile-card-avatar) {
    --avatar-size: var(--profile-avatar-size);

    background: var(--profile-card-ground);
    box-shadow: 0 0 0 0.25rem var(--profile-card-ground);
  }

  .profile-card-banner-button {
    background: none;
    border: 0;
    cursor: pointer;
    display: block;
    height: 100%;
    padding: 0;
    width: 100%;
  }

  .profile-card-banner-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
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

  :global(.profile-card-presence) {
    --presence-ring: var(--profile-card-ground);

    bottom: var(--space-050);
    position: absolute;
    right: 0;
    z-index: 1;
  }

  .profile-card-avatar-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Keep the bubble in the crest's flow so expansion clears the identity row. */
  .profile-card-status {
    background: var(--profile-panel-ground);
    border: var(--border-width) solid var(--profile-line);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    flex-shrink: 1;
    font-size: var(--font-size-label);
    line-height: var(--line-height-small);
    margin-left: var(--space-100);
    margin-top: calc(-1 * var(--space-600));
    min-width: var(--space-700);
    padding: var(--space-200) var(--space-200);
    position: relative;
    z-index: 1;
  }

  .profile-card-status::before {
    background: inherit;
    border: var(--border-width) solid var(--profile-line);
    border-bottom-width: 0;
    border-radius: var(--radius-pill) var(--radius-pill) 0 0;
    content: '';
    height: 0.4rem;
    left: 0.25rem;
    position: absolute;
    top: calc(-1 * var(--space-150));
    width: 0.8rem;
    z-index: -1;
  }

  .profile-card-status::after {
    background: inherit;
    border: var(--border-width) solid var(--profile-line);
    border-radius: var(--radius-pill);
    content: '';
    height: 8px;
    left: -3px;
    position: absolute;
    top: -12px;
    width: 8px;
    z-index: -1;
  }

  .profile-card-status-text {
    -webkit-box-orient: vertical;
    box-orient: vertical;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    margin: 0;
    max-height: var(--space-1000);
    overflow: hidden;
    overflow-wrap: anywhere;
    overscroll-behavior: contain;
    padding: 0;
  }

  .profile-card-status-text:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  .profile-card-status:hover .profile-card-status-text,
  .profile-card-status:focus-within .profile-card-status-text {
    display: block;
    -webkit-line-clamp: unset;
    line-clamp: unset;
    overflow-y: auto;
  }

  .profile-card-status-emoji {
    font-size: var(--font-size-heading);
    margin-right: var(--space-150);
  }

  .profile-card-identity {
    padding: var(--space-300) var(--space-400) var(--space-400);
  }

  .profile-card-popover.tinted.profile-card-inset-body {
    padding-bottom: var(--space-200);
  }

  .profile-card-popover.tinted.profile-card-inset-body .profile-card-identity {
    padding-inline: 0;
    padding-bottom: 0;
    padding-top: 0;
  }

  .profile-card-popover.tinted.profile-card-inset-body .profile-card-body {
    background: var(--profile-panel-ground);
    border: var(--border-width) solid var(--profile-line);
    border-radius: var(--radius-inner);
    margin: 0 var(--space-200);
    padding: var(--space-200) var(--space-300);
  }

  .profile-card-heading {
    align-items: baseline;
    display: flex;
    flex-flow: row wrap;
    gap: var(--space-200);
  }

  .profile-card-heading :global(.btn:last-child) {
    margin-left: auto;
  }

  .profile-card-name,
  .profile-card-user-id {
    margin: 0;
  }

  .profile-card-name {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    letter-spacing: -0.01em;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .profile-card-name.tinted,
  :global(.profile-card-tinted) {
    color: var(--profile-name-color);
  }

  .profile-card-user-id {
    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radii-200);
    color: var(--profile-text-muted);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    overflow-wrap: anywhere;
    padding: 0;
    text-align: start;
  }

  .profile-card-user-id :global(svg) {
    flex: none;
  }

  @media (hover: hover) and (pointer: fine) {
    .profile-card-popover.profile-card-inset-body .profile-card-user-id :global(svg) {
      opacity: 0;
    }

    .profile-card-popover.profile-card-inset-body .profile-card-user-id:hover :global(svg),
    .profile-card-popover.profile-card-inset-body .profile-card-user-id:focus-visible :global(svg) {
      opacity: 1;
    }
  }

  @media (pointer: coarse) {
    .profile-card-user-id {
      min-height: var(--control-height-large);
    }
  }

  .profile-card-user-id:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  /* Items sit next to each other and wrap. Equal grid columns left a short fact
     like "she/her" stranded half a card away from the next one. */

  .profile-card-meta {
    color: var(--profile-text-muted);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-100) var(--space-300);
    line-height: var(--line-height-small);
    margin-top: var(--space-150);
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

  .profile-card-popover.tinted.profile-card-inset-body .profile-card-panel {
    margin-inline: 0;
    margin-top: var(--space-200);
  }

  /* Padding sits on the rows, not here, so the divider between them can reach
     both edges of the panel. */
  .profile-card-panel.framed {
    background: var(--profile-panel-ground);
    border: var(--border-width) solid var(--profile-line);
    border-radius: var(--radius-inner);
    color: var(--surface-var-on-container);
    overflow: clip;
  }

  .profile-card.tinted .profile-card-status,
  .profile-card.tinted .profile-card-panel.framed {
    color: var(--profile-ink);
  }

  .profile-card-popover.tinted.profile-card-inset-body .profile-card-panel.framed {
    background: var(--profile-hero);
    border: 0;
    border-radius: var(--radii-400);
    box-shadow: inset 0 1px 2px color-mix(in srgb, var(--profile-ink) 12%, transparent);
  }

  .profile-card-popover.tinted.profile-card-inset-body .profile-card-footer {
    display: flex;
    flex-direction: column;
    text-align: center;
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
    margin-block: var(--space-300);
    max-height: calc(var(--profile-bio-lines) * var(--line-height-body) * 1em);
    overflow-wrap: break-word;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-inline: var(--space-300);
  }

  .profile-card-bio:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  .profile-card-popover.tinted.profile-card-inset-body .profile-card-bio {
    margin-block: 0;
    max-height: 12.5rem;
    padding: var(--space-200);
  }

  .profile-card-bio :global(.formatted-body) {
    white-space: normal;
  }

  .profile-card.tinted :global(.formatted-body a:not([data-matrix-link], [data-settings-link])) {
    color: var(--profile-ink);
    text-decoration: underline;
  }

  .profile-card.tinted :global(.formatted-body code:not(pre code)) {
    background: var(--profile-card-ground);
    border-color: var(--profile-line);
    color: var(--profile-ink);
  }

  .profile-card.tinted :global(.formatted-body .code-block) {
    color: var(--surface-var-on-container);
  }

  /* No hairline: the framed panel above already draws one edge, and two reads as
     a double rule. */
  .profile-card-composer {
    padding: 0 var(--space-400) var(--space-400);
  }

  .profile-card-below {
    padding: 0 var(--space-400) var(--space-400);
  }

  .profile-card-popover.tinted.profile-card-inset-body .profile-card-below {
    padding: var(--space-200) 0 0;
  }

  .profile-card-footer.divided {
    border-top: var(--border-width) solid var(--profile-line);
  }

  .profile-card-popover.tinted.profile-card-inset-body .profile-card-footer.divided {
    border-top: 0;
  }

  @media (prefers-color-scheme: dark) {
    :root:not(.light) .profile-card-name.tinted,
    :root:not(.light) :global(.profile-card-tinted),
    :root.dark .profile-card-name.tinted,
    :root.dark :global(.profile-card-tinted) {
      color: var(--profile-name-color-dark);
    }
  }

  :root.dark .profile-card-name.tinted,
  :root.dark :global(.profile-card-tinted) {
    color: var(--profile-name-color-dark);
  }

  .profile-card.tinted .profile-card-name.tinted,
  .profile-card.tinted :global(.profile-card-tinted) {
    color: var(--profile-name-on-hero, var(--profile-ink));
  }
</style>
