<script lang="ts">
  import { Popover } from 'bits-ui';
  import HeartIcon from 'phosphor-svelte/lib/HeartIcon';
  import type { ClassValue } from 'svelte/elements';

  import { SABLE_DONATE_URL } from '#lib/config/links.js';
  import { i18n } from '#lib/i18n.js';
  import { overlayLayer } from '#lib/ui/overlay-layer.js';
  import LinkButton from '#lib/ui/primitives/LinkButton.svelte';

  import SupporterMark from './SupporterMark.svelte';
  import {
    supporterAppearance,
    supporterButtonText,
    supporterColor,
    type SupporterAppearance,
  } from './variants.js';

  type Props = Partial<SupporterAppearance> & {
    label: string;
    name?: string;
    title?: string;
    class?: ClassValue;
  };

  let { label, name, title, class: className = '', ...appearance }: Props = $props();
  let selected = $derived(supporterAppearance(appearance));
  let { variant, color, customCardColors, cardColor, buttonColor } = $derived(selected);
  const id = $props.id();
  const nameSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let donorName = $derived.by(() => {
    let shortened = '';
    let count = 0;
    for (const { segment } of nameSegments.segment(name?.trim() || $i18n.t('supporter.donor'))) {
      if (count++ === 24) return `${shortened}…`;
      shortened += segment;
    }
    return shortened;
  });
  const palettes = {
    gold: ['var(--supporter-gold)', 'var(--supporter-gold)'],
    propeller: ['var(--supporter-yellow)', 'var(--supporter-red)'],
    agender: ['var(--supporter-green)', 'var(--supporter-silver)'],
    bisexual: ['var(--supporter-bisexual-pink)', 'var(--supporter-bisexual-blue)'],
    trans: ['var(--supporter-blue)', 'var(--supporter-pink)'],
    transgradient: ['var(--supporter-blue)', 'var(--supporter-pink)'],
    intersex: ['var(--supporter-yellow)', 'var(--supporter-purple)'],
    lesbian: ['var(--supporter-orange)', 'var(--supporter-bisexual-pink)'],
    mlm: ['var(--supporter-teal)', 'var(--supporter-bisexual-blue)'],
    pride: ['var(--supporter-orange)', 'var(--supporter-purple)'],
  };
  let customStyle = $derived.by(() => {
    const [start, end] =
      variant === 'custom'
        ? [supporterColor(color), supporterColor(color)]
        : (palettes[variant] ?? palettes.gold);
    const ground = cardColor;
    const button = customCardColors ? buttonColor : variant === 'pride' ? end : start;
    const ink =
      customCardColors || variant === 'custom'
        ? supporterButtonText(button)
        : variant === 'bisexual'
          ? 'var(--supporter-white)'
          : 'var(--supporter-card-bg)';
    const mix = customCardColors
      ? ink === 'var(--supporter-white)'
        ? 'var(--supporter-black)'
        : 'var(--supporter-white)'
      : variant === 'custom' && ink !== 'var(--supporter-white)'
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

<Popover.Root>
  <Popover.Trigger
    class={['supporter-badge', className]}
    data-supporter-variant={variant}
    style={customStyle}
    aria-label={`${label} · ${title ?? $i18n.t('timeline.profileSupporter')}`}
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
      collisionPadding={12}
      trapFocus={false}
      role="dialog"
      aria-labelledby={`${id}-heading`}
      aria-describedby={`${id}-description`}
    >
      <div class="supporter-card-art" aria-hidden="true">
        <SupporterMark {...selected} />
      </div>
      <h2 id={`${id}-heading`}>{label}</h2>
      <p id={`${id}-description`}>{$i18n.t('supporter.badgeDescription', { name: donorName })}</p>
      <LinkButton
        href={SABLE_DONATE_URL}
        target="_blank"
        rel="noopener noreferrer"
        block
        class="supporter-card-donate"
      >
        <HeartIcon aria-hidden="true" weight="fill" />
        {$i18n.t('supporter.badgeDonate')}
      </LinkButton>
      <small class="supporter-card-hint">{$i18n.t('supporter.badgeHint')}</small>
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
</style>
