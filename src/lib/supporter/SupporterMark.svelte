<script lang="ts">
  import ceoArt from './ceo.png';
  import {
    APP_ICON_STOPS,
    CRISP_PRIDE_STOPS,
    GHOST_SABLE_PATH,
    SABLE_EYE_PATH,
    SABLE_PATHS,
    PAW_PATH,
  } from './icon-art.js';
  import {
    isSupporterColors,
    supporterButtonText,
    supporterColor,
    supporterGradientAngle,
    supporterVariant,
    supportsSupporterColors,
    DEFAULT_SUPPORTER_BACKGROUND_COLOR,
    type SupporterAppearance,
  } from './variants.js';

  let {
    variant = 'gold',
    shape = 'circle',
    customBackground = false,
    backgroundColor = DEFAULT_SUPPORTER_BACKGROUND_COLOR,
    color,
    colors,
    gradientAngle,
  }: Partial<SupporterAppearance> = $props();
  const id = $props.id();
  let chosen = $derived(supporterVariant(variant));
  let customizable = $derived(supportsSupporterColors(chosen));
  let customStops = $derived.by(() => {
    if (!customizable || !isSupporterColors(colors)) return null;
    const count = colors.length;
    return colors.map((col, index) => ({
      color: supporterColor(col),
      offset: String(index / (count - 1)),
    }));
  });
  let customCoords = $derived.by(() => {
    const angle = supporterGradientAngle(gradientAngle);
    const rad = ((angle - 90) * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const x1 = Math.round((0.5 - 0.5 * dx) * 1000) / 10;
    const y1 = Math.round((0.5 - 0.5 * dy) * 1000) / 10;
    const x2 = Math.round((0.5 + 0.5 * dx) * 1000) / 10;
    const y2 = Math.round((0.5 + 0.5 * dy) * 1000) / 10;
    return { x1: `${x1}%`, y1: `${y1}%`, x2: `${x2}%`, y2: `${y2}%` };
  });
  let stops = $derived(customStops ?? CRISP_PRIDE_STOPS[chosen] ?? APP_ICON_STOPS[chosen]);
  let isVertical = $derived(chosen in CRISP_PRIDE_STOPS && chosen !== 'intersex');
  let backing = $derived(
    customBackground
      ? supporterColor(backgroundColor, DEFAULT_SUPPORTER_BACKGROUND_COLOR)
      : customizable &&
          supporterButtonText(customStops ? colors?.[0] : color) === 'var(--supporter-white)'
        ? 'var(--supporter-white)'
        : 'var(--supporter-card-bg)'
  );
</script>

<svg
  class="supporter-mark"
  data-variant={chosen}
  style:color={customizable && !customStops ? supporterColor(color) : undefined}
  viewBox="0 0 512 512"
  fill="none"
  aria-hidden="true"
  xmlns="http://www.w3.org/2000/svg"
>
  <defs>
    {#if chosen === 'intersex'}
      <radialGradient {id} cx="50%" cy="54%" r="38%">
        {#each stops ?? [] as stop, index (index)}<stop
            offset={stop.offset}
            stop-color={stop.color}
          />{/each}
      </radialGradient>
    {:else}
      <linearGradient
        {id}
        x1={customStops ? customCoords.x1 : '0'}
        y1={customStops ? customCoords.y1 : '0'}
        x2={customStops ? customCoords.x2 : isVertical ? '0' : '1'}
        y2={customStops ? customCoords.y2 : isVertical ? '1' : '0'}
      >
        {#each stops ?? [] as stop, index (index)}<stop
            offset={stop.offset}
            stop-color={stop.color}
          />{/each}
      </linearGradient>
    {/if}
  </defs>
  {#if chosen === 'ceo'}
    <image href={ceoArt} width="512" height="512" />
  {:else}
    {#if shape === 'circle'}
      <circle fill={backing} cx="256" cy="256" r="256" />
    {:else if shape === 'heart'}
      <path
        fill={backing}
        d="M256 492 58 302C-64 184 43 5 166 56c38 16 65 44 90 77 25-33 52-61 90-77 123-51 230 128 108 246Z"
      />
    {:else if shape === 'square'}
      <rect fill={backing} width="512" height="512" rx="112" />
    {/if}
    <g
      transform={shape === 'heart'
        ? 'translate(82 55) scale(.68)'
        : shape === 'square'
          ? 'translate(26 26) scale(.9)'
          : undefined}
    >
      {#if chosen === 'paw'}
        <path fill={stops ? 'url(#' + id + ')' : 'currentColor'} d={PAW_PATH} />
      {:else}
        <path
          fill={stops ? 'url(#' + id + ')' : 'currentColor'}
          d={chosen === 'ghost' ? GHOST_SABLE_PATH : SABLE_PATHS[0]}
        />
        <path fill={backing} opacity="0.45" d={SABLE_PATHS[1]} />
      {/if}
      {#if chosen === 'propeller'}
        <path fill="var(--supporter-red)" d="M125 174C146 81 277 69 324 150L225 174Z" />
        <path fill="var(--supporter-yellow)" d="M125 174C138 107 175 87 222 96L237 171Z" />
        <path
          fill="var(--supporter-propeller-blue)"
          d="M122 171Q233 178 337 143L351 150Q227 203 122 183Z"
        />
        <path stroke="var(--supporter-propeller-blue)" stroke-width="7" d="M224 104 214 44" />
        <ellipse
          fill="var(--supporter-propeller-blue)"
          cx="211"
          cy="48"
          rx="84"
          ry="8"
          transform="rotate(-18 211 48)"
        />
      {:else if chosen === 'evil'}
        <path fill="var(--supporter-red)" d={SABLE_EYE_PATH} />
      {/if}
    </g>
  {/if}
</svg>

<style>
  .supporter-mark {
    color: var(--supporter-gold);
    display: block;
    flex-shrink: 0;
    height: 100%;
    width: 100%;
  }

  .supporter-mark[data-variant='propeller'] {
    color: var(--supporter-purple);
  }

  .supporter-mark[data-variant='ghost'] {
    color: var(--supporter-white);
  }

  .supporter-mark[data-variant='evil'] {
    color: var(--supporter-evil);
  }
</style>
