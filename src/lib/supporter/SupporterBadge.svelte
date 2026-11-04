<script lang="ts">
  import { Popover } from 'bits-ui';
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
  import type { ClassValue } from 'svelte/elements';

  import { donateUrl } from '#lib/deployment/links.js';
  import { graphemes } from '#lib/graphemes.js';
  import { i18n } from '#lib/i18n.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import { collisionPadding } from '#lib/ui/titlebar-inset.svelte.js';
  import LinkButton from '#lib/ui/primitives/LinkButton.svelte';

  import SupporterMark from './SupporterMark.svelte';
  import { supporter } from './supporter.svelte.js';
  import {
    isSupporterColors,
    supporterAppearance,
    supporterButtonText,
    supporterColor,
    supportsSupporterColors,
    type SupporterAppearance,
    type SupporterVariant,
  } from './variants.js';

  type Props = Partial<SupporterAppearance> & {
    label: string;
    name?: string;
    title?: string;
    viewerIsDonor?: boolean;
    isOwnBadge?: boolean;
    class?: ClassValue;
  };

  let {
    label,
    name,
    title,
    viewerIsDonor,
    isOwnBadge = false,
    class: className = '',
    ...appearance
  }: Props = $props();
  let donated = $derived(viewerIsDonor ?? (isOwnBadge || Boolean(supporter.badge)));
  let selected = $derived(supporterAppearance(appearance));
  let { variant, color, colors, customCardColors, cardColor, buttonColor } = $derived(selected);
  const id = $props.id();
  let donateHref = $derived(donateUrl());
  let open = $state(false);
  let donorName = $derived.by(() => {
    let shortened = '';
    let count = 0;
    for (const { segment } of graphemes.segment(name?.trim() || i18n.t('supporter.donor'))) {
      if (count++ === 24) return `${shortened}…`;
      shortened += segment;
    }
    return shortened;
  });
  const palettes: Record<SupporterVariant, [string, string]> = {
    gold: ['var(--supporter-gold)', 'var(--supporter-gold)'],
    custom: ['var(--supporter-gold)', 'var(--supporter-gold)'],
    paw: ['var(--supporter-purple)', 'var(--supporter-purple)'],
    propeller: ['var(--supporter-yellow)', 'var(--supporter-red)'],
    ghost: ['var(--supporter-white)', 'var(--supporter-silver)'],
    evil: ['var(--supporter-red)', 'var(--supporter-evil)'],
    agender: ['var(--supporter-agender-green)', 'var(--supporter-agender-gray)'],
    agendergradient: ['var(--supporter-agender-green)', 'var(--supporter-agender-gray)'],
    nonbinary: ['var(--supporter-nonbinary-yellow)', 'var(--supporter-nonbinary-purple)'],
    nonbinarygradient: ['var(--supporter-nonbinary-yellow)', 'var(--supporter-nonbinary-purple)'],
    genderfluid: ['var(--supporter-genderfluid-pink)', 'var(--supporter-genderfluid-blue)'],
    genderfluidgradient: ['var(--supporter-genderfluid-pink)', 'var(--supporter-genderfluid-blue)'],
    asexual: ['var(--supporter-asexual-black)', 'var(--supporter-asexual-purple)'],
    asexualgradient: ['var(--supporter-asexual-black)', 'var(--supporter-asexual-purple)'],
    aromantic: ['var(--supporter-aromantic-green)', 'var(--supporter-aromantic-gray)'],
    aromanticgradient: ['var(--supporter-aromantic-green)', 'var(--supporter-aromantic-gray)'],
    aroace: ['var(--supporter-aroace-orange)', 'var(--supporter-aroace-navy)'],
    aroacegradient: ['var(--supporter-aroace-orange)', 'var(--supporter-aroace-navy)'],
    graysexual: ['var(--supporter-graysexual-purple)', 'var(--supporter-graysexual-gray)'],
    graysexualgradient: ['var(--supporter-graysexual-purple)', 'var(--supporter-graysexual-gray)'],
    polysexual: ['var(--supporter-polysexual-pink)', 'var(--supporter-polysexual-blue)'],
    polysexualgradient: ['var(--supporter-polysexual-pink)', 'var(--supporter-polysexual-blue)'],
    omnisexual: [
      'var(--supporter-omnisexual-light-pink)',
      'var(--supporter-omnisexual-light-blue)',
    ],
    omnisexualgradient: [
      'var(--supporter-omnisexual-light-pink)',
      'var(--supporter-omnisexual-light-blue)',
    ],
    genderqueer: ['var(--supporter-genderqueer-purple)', 'var(--supporter-genderqueer-green)'],
    genderqueergradient: [
      'var(--supporter-genderqueer-purple)',
      'var(--supporter-genderqueer-green)',
    ],
    bigender: ['var(--supporter-bigender-pink)', 'var(--supporter-bigender-blue)'],
    bigendergradient: ['var(--supporter-bigender-pink)', 'var(--supporter-bigender-blue)'],
    demigender: ['var(--supporter-demigender-gray)', 'var(--supporter-demigender-yellow)'],
    demigendergradient: ['var(--supporter-demigender-gray)', 'var(--supporter-demigender-yellow)'],
    pluraljourney: ['var(--supporter-pluraljourney-purple)', 'var(--supporter-black)'],
    pluraljourneygradient: ['var(--supporter-pluraljourney-purple)', 'var(--supporter-black)'],
    bisexual: ['var(--supporter-bisexual-pink)', 'var(--supporter-bisexual-blue)'],
    bisexualgradient: ['var(--supporter-bisexual-pink)', 'var(--supporter-bisexual-blue)'],
    pansexual: ['var(--supporter-pansexual-pink)', 'var(--supporter-pansexual-blue)'],
    pansexualgradient: ['var(--supporter-pansexual-pink)', 'var(--supporter-pansexual-blue)'],
    trans: ['var(--supporter-trans-blue)', 'var(--supporter-trans-pink)'],
    transgradient: ['var(--supporter-trans-blue)', 'var(--supporter-trans-pink)'],
    intersex: ['var(--supporter-intersex-yellow)', 'var(--supporter-intersex-purple)'],
    intersexgradient: ['var(--supporter-intersex-yellow)', 'var(--supporter-intersex-purple)'],
    lesbian: ['var(--supporter-lesbian-dark-orange)', 'var(--supporter-lesbian-dark-magenta)'],
    lesbiangradient: [
      'var(--supporter-lesbian-dark-orange)',
      'var(--supporter-lesbian-dark-magenta)',
    ],
    mlm: ['var(--supporter-mlm-green)', 'var(--supporter-mlm-indigo)'],
    mlmgradient: ['var(--supporter-mlm-green)', 'var(--supporter-mlm-indigo)'],
    pride: ['var(--supporter-rainbow-red)', 'var(--supporter-rainbow-violet)'],
    pridegradient: ['var(--supporter-rainbow-red)', 'var(--supporter-rainbow-violet)'],
    ukraine: ['var(--supporter-ukraine-blue)', 'var(--supporter-ukraine-yellow)'],
    palestine: ['var(--supporter-palestine-red)', 'var(--supporter-palestine-green)'],
    cuba: ['var(--supporter-cuba-blue)', 'var(--supporter-cuba-red)'],
    ceo: ['var(--supporter-gold)', 'var(--supporter-gold)'],
  };
  let customStyle = $derived.by(() => {
    const [start, end] = supportsSupporterColors(variant)
      ? isSupporterColors(colors)
        ? [supporterColor(colors[0]), supporterColor(colors.at(-1))]
        : [supporterColor(color), supporterColor(color)]
      : (palettes[variant] ?? palettes.gold);
    const ground = cardColor;
    const button = customCardColors
      ? buttonColor
      : variant === 'pride' || variant === 'pridegradient'
        ? end
        : start;
    const ink =
      customCardColors || supportsSupporterColors(variant)
        ? supporterButtonText(button)
        : [
              'bisexual',
              'bisexualgradient',
              'asexual',
              'asexualgradient',
              'graysexual',
              'graysexualgradient',
              'demigender',
              'demigendergradient',
              'lesbian',
              'lesbiangradient',
              'mlm',
              'mlmgradient',
              'pride',
              'pridegradient',
              'ukraine',
              'cuba',
            ].includes(variant)
          ? 'var(--supporter-white)'
          : variant === 'palestine'
            ? 'var(--supporter-black)'
            : 'var(--supporter-card-bg)';
    const mix = customCardColors
      ? ink === 'var(--supporter-white)'
        ? 'var(--supporter-black)'
        : 'var(--supporter-white)'
      : supportsSupporterColors(variant) && ink !== 'var(--supporter-white)'
        ? 'var(--supporter-white)'
        : 'var(--supporter-card-bg)';
    return `
      --supporter-accent-start: ${start};
      --supporter-accent-end: ${end};
      --supporter-button: ${button};
      --supporter-button-text: ${ink};
      --supporter-button-mix: ${mix};
      --supporter-card-ground: ${ground};
      --supporter-card-ink: ${supporterButtonText(ground)};
    `;
  });
</script>

<svelte:window onblur={() => (open = false)} />

<Popover.Root bind:open>
  <Popover.Trigger
    class={['supporter-badge', className]}
    data-supporter-variant={variant}
    style={customStyle}
    aria-label={`${label} · ${title ?? i18n.t('timeline.profileSupporter')}`}
    openOnHover
    openDelay={180}
    closeDelay={200}
  >
    <SupporterMark {...selected} />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      class="supporter-card"
      data-supporter-variant={variant}
      data-custom-colors={customCardColors || undefined}
      style={customStyle}
      {...overlayLayer()}
      side="bottom"
      align="end"
      sideOffset={10}
      collisionPadding={collisionPadding(12)}
      trapFocus={false}
      role="dialog"
      aria-labelledby={`${id}-heading`}
      aria-describedby={donateHref ? `${id}-description` : undefined}
    >
      <div class="supporter-card-art" aria-hidden="true">
        <SupporterMark {...selected} />
      </div>
      <h2 id={`${id}-heading`}>{label}</h2>
      {#if donateHref}
        <p id={`${id}-description`}>
          {i18n.t(
            isOwnBadge
              ? 'supporter.badgeOwnDescription'
              : donated
                ? 'supporter.badgeDonorDescription'
                : 'supporter.badgeDescription',
            { name: donorName }
          )}
        </p>
        <LinkButton
          href={donateHref}
          target="_blank"
          rel="noopener noreferrer"
          block
          class="supporter-card-donate"
          onclick={() => (open = false)}
        >
          <HeartIcon aria-hidden="true" weight="fill" />
          {i18n.t(donated ? 'common.supportSable' : 'supporter.badgeDonate')}
        </LinkButton>
        <small class="supporter-card-hint"
          >{i18n.t(donated ? 'supporter.badgeDonorHint' : 'supporter.badgeHint')}</small
        >
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  :global(.supporter-badge) {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radii-300);
    cursor: pointer;
    display: inline-flex;
    flex-shrink: 0;
    height: var(--size-x500);
    justify-content: center;
    padding: var(--space-050);
    vertical-align: middle;
    width: var(--size-x500);
  }

  :global(.supporter-badge .supporter-mark) {
    filter: drop-shadow(0 0 var(--space-050) transparent);
  }

  :global(.supporter-badge:hover .supporter-mark),
  :global(.supporter-badge:focus-visible .supporter-mark),
  :global(.supporter-badge[data-state='open'] .supporter-mark) {
    filter: drop-shadow(
      0 0 var(--space-050) color-mix(in srgb, var(--supporter-accent-start) 50%, transparent)
    );
  }

  :global(.supporter-badge:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.supporter-card) {
    background: linear-gradient(
      125deg,
      color-mix(in srgb, var(--supporter-accent-start) 18%, var(--surface-container)),
      color-mix(in srgb, var(--supporter-accent-end) 8%, var(--surface-container))
    );
    border: var(--border-width) solid
      color-mix(in srgb, var(--supporter-accent-start) 45%, var(--surface-container-line));
    border-radius: var(--radii-500);
    box-shadow: var(--shadow-float);
    box-sizing: border-box;
    color: var(--surface-on-container);
    display: grid;
    gap: var(--space-200) var(--space-300);
    grid-template-columns: 2.5rem minmax(0, 1fr);
    max-width: calc(100vw - 2 * var(--space-400));
    overflow: hidden;
    padding: var(--space-400);
    transform-origin: var(--bits-floating-transform-origin);
    width: 17rem;
  }

  :global(.supporter-card[data-custom-colors]) {
    --supporter-body-ink: var(--supporter-card-ink);

    background: var(--supporter-card-ground);
    border-color: color-mix(in srgb, var(--supporter-card-ink) 25%, var(--supporter-card-ground));
    color: var(--supporter-card-ink);
  }

  :global(.supporter-card[data-custom-colors] .supporter-card-donate) {
    border-color: color-mix(in srgb, var(--supporter-card-ink) 25%, var(--supporter-card-ground));
  }

  .supporter-card-art {
    grid-column: 1;
    grid-row: 1;
    height: 2.5rem;
    width: 2.5rem;
  }

  h2 {
    align-self: center;
    font-size: calc(1.25rem * var(--text-scale));
    font-weight: var(--font-weight-700);
    grid-column: 2;
    line-height: var(--line-height-heading);
    margin: 0;
    overflow-wrap: anywhere;
  }

  p {
    color: var(--supporter-body-ink, var(--sec-on-container));
    font-size: var(--font-size-label);
    grid-column: 1 / -1;
    line-height: var(--line-height-body);
    margin: 0;
    overflow-wrap: anywhere;
  }

  :global(.supporter-card-donate) {
    --button-container: var(--supporter-button);
    --button-container-hover: color-mix(
      in srgb,
      var(--supporter-button) 90%,
      var(--supporter-button-mix, var(--supporter-card-bg))
    );
    --button-container-active: color-mix(
      in srgb,
      var(--supporter-button) 85%,
      var(--supporter-button-mix, var(--supporter-card-bg))
    );
    --button-on-container: var(--supporter-button-text);

    grid-column: 1 / -1;
    margin-top: var(--space-100);
  }

  .supporter-card-hint {
    color: var(--supporter-body-ink, var(--sec-on-container));
    font-size: var(--font-size-small);
    grid-column: 1 / -1;
    line-height: var(--line-height-body);
    text-align: center;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.supporter-badge .supporter-mark) {
      transition: filter var(--motion-normal) ease-out;
    }

    :global(.supporter-card[data-state='open']) {
      animation: supporter-card-in var(--motion-normal) ease-out both;
    }

    :global(.supporter-card[data-state='closed']) {
      animation: supporter-card-out var(--motion-fast) ease-out both;
    }
  }

  @keyframes supporter-card-in {
    from {
      opacity: 0;
      scale: 0.98;
    }
  }

  @keyframes supporter-card-out {
    to {
      opacity: 0;
      scale: 0.98;
    }
  }

  @supports not (color: color-mix(in srgb, black, white)) {
    :global(.supporter-badge:hover .supporter-mark),
    :global(.supporter-badge:focus-visible .supporter-mark),
    :global(.supporter-badge[data-state='open'] .supporter-mark) {
      filter: drop-shadow(0 0 var(--space-050) var(--supporter-accent-start));
    }

    :global(.supporter-card) {
      background: var(--surface-container);
      border: var(--border-width) solid var(--surface-var-container-line);
    }

    :global(.supporter-card[data-custom-colors]),
    :global(.supporter-card[data-custom-colors] .supporter-card-donate) {
      border-color: var(--surface-var-container-line);
    }

    :global(.supporter-card-donate) {
      --button-container-hover: var(--supporter-button);
      --button-container-active: var(--supporter-button);
    }
  }
</style>
