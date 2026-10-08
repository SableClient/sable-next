<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { tick } from 'svelte';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import SupporterMark from './SupporterMark.svelte';
  import SupporterBadge from './SupporterBadge.svelte';
  import ColorSetting from '#lib/features/settings/ColorSetting.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import {
    DEFAULT_GRADIENT_ANGLE,
    DEFAULT_SUPPORTER_COLOR,
    DEFAULT_SUPPORTER_GRADIENT_COLOR,
    MAX_SUPPORTER_GRADIENT_COLORS,
    SUPPORTER_SHAPES,
    SUPPORTER_VARIANTS,
    isSupporterColor,
    isSupporterColors,
    supporterAppearance,
    supporterColor,
    supporterGradientAngle,
    supportsSupporterColors,
    type SupporterAppearance,
    type SupporterVariant,
  } from './variants.js';

  let {
    value,
    name: donorName,
    disabled = false,
    onChange,
  }: {
    value: SupporterAppearance;
    name?: string;
    disabled?: boolean;
    onChange: (patch: Partial<SupporterAppearance>) => void | Promise<void>;
  } = $props();
  const name = $props.id();
  const defaults = supporterAppearance();
  const colorLabels = {
    color: 'customColor',
    backgroundColor: 'backgroundColor',
    cardColor: 'cardColor',
    buttonColor: 'buttonColor',
  };
  type ColorKey = keyof typeof colorLabels;
  let draft = $derived({
    ...value,
    colors: isSupporterColors(value.colors) ? [...value.colors] : undefined,
    gradientAngle: value.gradientAngle ?? DEFAULT_GRADIENT_ANGLE,
  });

  let liveAngle = $state<number | null>(null);
  let displayAngle = $derived(liveAngle ?? draft.gradientAngle ?? DEFAULT_GRADIENT_ANGLE);
  let isGradient = $derived(isSupporterColors(draft.colors));

  function badgeLabel(variant: SupporterVariant): string {
    if (variant === 'gold' || variant === 'custom' || variant === 'ghost' || variant === 'evil') {
      return $i18n.t(`supporter.colors.${variant}`);
    }
    if (variant === 'paw') {
      return $i18n.t(`supporter.designs.${variant}`);
    }
    return $i18n.t(`settings.appIcons.${variant}`);
  }

  async function update(patch: Partial<SupporterAppearance>): Promise<void> {
    draft = { ...draft, ...patch };
    try {
      await onChange(patch);
    } finally {
      await tick();
      draft = {
        ...value,
        colors: isSupporterColors(value.colors) ? [...value.colors] : undefined,
        gradientAngle: value.gradientAngle ?? DEFAULT_GRADIENT_ANGLE,
      };
    }
  }

  async function commitColor(key: ColorKey, next = draft[key]): Promise<void> {
    if (!isSupporterColor(next)) return;
    const normalized = supporterColor(next, defaults[key]);
    if (normalized !== value[key]) await update({ [key]: normalized });
  }

  async function commitColors(colors: string[]): Promise<void> {
    await update({ colors, color: colors[0] });
  }

  async function commitGradientColor(index: number): Promise<void> {
    const nextHex = draft.colors?.[index];
    if (!isSupporterColor(nextHex)) return;
    const colors = [...(draft.colors ?? [])];
    colors[index] = supporterColor(nextHex);
    await commitColors(colors);
  }

  async function addGradientColor(): Promise<void> {
    const colors = draft.colors ?? [];
    if (colors.length >= MAX_SUPPORTER_GRADIENT_COLORS) return;
    const last = colors.at(-1) ?? DEFAULT_SUPPORTER_GRADIENT_COLOR;
    await commitColors([...colors, last]);
  }

  async function removeGradientColor(index: number): Promise<void> {
    const colors = draft.colors ?? [];
    if (colors.length <= 2) return;
    await commitColors(colors.filter((_, i) => i !== index));
  }

  async function commitGradientAngle(angle: number): Promise<void> {
    const normalized = supporterGradientAngle(angle);
    if (normalized !== value.gradientAngle) {
      await update({ gradientAngle: normalized });
    }
  }

  async function toggleGradient(enabled: boolean): Promise<void> {
    if (enabled) {
      const initial = [value.color, DEFAULT_SUPPORTER_GRADIENT_COLOR];
      await update({
        colors: initial,
        color: initial[0],
        gradientAngle: value.gradientAngle ?? DEFAULT_GRADIENT_ANGLE,
      });
    } else {
      await update({
        colors: undefined,
        gradientAngle: undefined,
        color: draft.colors?.[0] ?? value.color,
      });
    }
  }
</script>

{#snippet colorEditor(keys: ColorKey[])}
  <div class="custom-editor">
    <div class="card-color-settings">
      {#each keys as key (key)}
        <ColorSetting
          label={$i18n.t(`supporter.${colorLabels[key]}`)}
          bind:value={draft[key]}
          onCommit={() => void commitColor(key)}
          onReset={() => void commitColor(key, defaults[key])}
        />
      {/each}
    </div>
    <SupporterBadge
      label={$i18n.t('supporter.donor')}
      name={donorName}
      isOwnBadge
      {...draft}
      gradientAngle={displayAngle}
    />
  </div>
{/snippet}

<fieldset class="badge-picker" {disabled}>
  <legend>{$i18n.t('supporter.chooseBadge')}</legend>
  <p>{$i18n.t('supporter.chooseBadgeHint')}</p>
  <div class="badge-options">
    {#each SUPPORTER_VARIANTS as variant (variant)}
      <label class="badge-option" class:selected={draft.variant === variant}>
        <input
          type="radio"
          {name}
          value={variant}
          aria-labelledby={`${name}-${variant}-label`}
          aria-describedby={supportsSupporterColors(variant)
            ? `${name}-${variant}-colors`
            : undefined}
          checked={draft.variant === variant}
          onchange={() => void update({ variant })}
        />
        <span class="badge-option-mark"><SupporterMark {...draft} {variant} /></span>
        <span id={`${name}-${variant}-label`}>{badgeLabel(variant)}</span>
        {#if supportsSupporterColors(variant)}
          <small class="badge-option-customizable" id={`${name}-${variant}-colors`}
            >{$i18n.t('supporter.customizableColors')}</small
          >
        {/if}
      </label>
    {/each}
  </div>
  {#if supportsSupporterColors(draft.variant)}
    <div class="custom-badge">
      <h3>{$i18n.t('supporter.customizeBadge', { badge: badgeLabel(draft.variant) })}</h3>
      <p>{$i18n.t('supporter.customColorHint')}</p>
      <div class="custom-gradient-toggle">
        <div class="badge-background">
          <span class="custom-copy"
            ><strong>{$i18n.t('supporter.customGradient')}</strong><small
              >{$i18n.t('supporter.customGradientHint')}</small
            ></span
          >
          <Switch
            checked={isGradient}
            {disabled}
            label={$i18n.t('supporter.customGradient')}
            onCheckedChange={(enabled) => void toggleGradient(enabled)}
          />
        </div>
      </div>
      {#if !isGradient}
        {@render colorEditor(['color'])}
      {:else}
        <div class="custom-editor">
          <div class="card-color-settings">
            {#if draft.colors}
              {#each draft.colors.map((_, i) => i) as i (i)}
                <div class="gradient-stop-row">
                  <div class="gradient-stop-input">
                    <ColorSetting
                      label={$i18n.t('supporter.colorIndex', { index: i + 1 })}
                      bind:value={draft.colors[i]}
                      onCommit={() => void commitGradientColor(i)}
                      onReset={() => {
                        if (!draft.colors) return;
                        const next = [...draft.colors];
                        next[i] =
                          i === 0 ? DEFAULT_SUPPORTER_COLOR : DEFAULT_SUPPORTER_GRADIENT_COLOR;
                        void commitColors(next);
                      }}
                    />
                  </div>
                  {#if draft.colors.length > 2}
                    <IconButton
                      label={$i18n.t('common.remove')}
                      size="small"
                      variant="ghost"
                      onclick={() => void removeGradientColor(i)}
                    >
                      <TrashIcon />
                    </IconButton>
                  {/if}
                </div>
              {/each}
            {/if}
            {#if (draft.colors?.length ?? 0) < MAX_SUPPORTER_GRADIENT_COLORS}
              <Button variant="secondary" size="small" onclick={() => void addGradientColor()}>
                <PlusIcon />
                {$i18n.t('supporter.addColor')}
              </Button>
            {/if}
            <div class="gradient-angle-control">
              <div class="gradient-angle-header">
                <span>{$i18n.t('supporter.gradientAngle')}</span>
                <span class="gradient-angle-value">{displayAngle}°</span>
              </div>
              <Slider
                min={0}
                max={360}
                step={5}
                label={$i18n.t('supporter.gradientAngle')}
                value={displayAngle}
                oninput={(angle) => {
                  liveAngle = angle;
                }}
                oncommit={(angle) => {
                  liveAngle = null;
                  void commitGradientAngle(angle);
                }}
              />
            </div>
          </div>
          <SupporterBadge
            label={$i18n.t('supporter.donor')}
            name={donorName}
            isOwnBadge
            {...draft}
            gradientAngle={displayAngle}
          />
        </div>
      {/if}
    </div>
  {/if}
  <fieldset class="shape-picker">
    <legend>{$i18n.t('supporter.backgroundShape')}</legend>
    <div class="shape-options badge-options">
      {#each SUPPORTER_SHAPES as shape (shape)}
        <label class="badge-option" class:selected={draft.shape === shape}>
          <input
            type="radio"
            name={`${name}-shape`}
            value={shape}
            checked={draft.shape === shape}
            onchange={() => void update({ shape })}
          />
          <span class="badge-option-mark"
            ><SupporterMark {...draft} gradientAngle={displayAngle} {shape} /></span
          >
          <span>{$i18n.t(`supporter.shapes.${shape}`)}</span>
        </label>
      {/each}
    </div>
  </fieldset>
  {#if draft.shape !== 'none'}
    <div class="backing-colors">
      <div class="badge-background">
        <span>{$i18n.t('supporter.customBackground')}</span>
        <Switch
          checked={draft.customBackground}
          {disabled}
          label={$i18n.t('supporter.customBackground')}
          onCheckedChange={(customBackground) => void update({ customBackground })}
        />
      </div>
      {#if draft.customBackground}
        {@render colorEditor(['backgroundColor'])}
      {/if}
    </div>
  {/if}
  <div class="card-colors">
    <div class="badge-background">
      <span class="custom-copy"
        ><strong>{$i18n.t('supporter.customCardColors')}</strong><small
          >{$i18n.t('supporter.customCardColorsHint')}</small
        ></span
      >
      <Switch
        checked={draft.customCardColors}
        {disabled}
        label={$i18n.t('supporter.customCardColors')}
        onCheckedChange={(customCardColors) => void update({ customCardColors })}
      />
    </div>
    {#if draft.customCardColors}
      {@render colorEditor(['cardColor', 'buttonColor'])}
    {/if}
  </div>
</fieldset>

<style>
  .shape-picker {
    border: 0;
    border-top: var(--border-width) solid var(--surface-container-line);
    margin: var(--space-400) 0 0;
    min-width: 0;
    padding: var(--space-400) 0 0;
  }

  .shape-options.badge-options {
    clear: both;
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .backing-colors {
    margin-top: var(--space-400);
  }

  .card-color-settings {
    display: grid;
    gap: var(--space-400);
  }

  .custom-badge,
  .card-colors {
    border-top: var(--border-width) solid var(--surface-container-line);
    margin-top: var(--space-400);
    padding-top: var(--space-400);
  }

  .custom-gradient-toggle {
    margin-top: var(--space-300);
  }

  .custom-badge h3 {
    font-size: var(--font-size-subheading);
    font-weight: var(--font-weight-600);
    margin: 0 0 var(--space-100);
  }

  .badge-option-customizable {
    color: var(--sec-main);
    font-size: var(--font-size-small);
  }

  .gradient-stop-row {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .gradient-stop-input {
    flex: 1;
    min-width: 0;
  }

  .gradient-angle-control {
    display: flex;
    flex-direction: column;
    gap: var(--space-200);
    margin-top: var(--space-200);
  }

  .gradient-angle-header {
    display: flex;
    font-size: var(--font-size-label);
    justify-content: space-between;
  }

  .gradient-angle-value {
    color: var(--sec-main);
  }

  .custom-copy {
    display: grid;
    gap: var(--space-050);
  }

  .custom-copy strong {
    font-size: var(--font-size-subheading);
    font-weight: var(--font-weight-600);
  }

  .custom-copy small {
    color: var(--sec-main);
    font-size: var(--font-size-label);
  }

  .custom-editor {
    align-items: center;
    display: grid;
    gap: var(--space-300);
    grid-template-columns: minmax(0, 1fr) auto;
    margin-top: var(--space-300);
  }

  .badge-picker {
    background: var(--surface-container);
    border: 0;
    color: var(--surface-on-container);
    margin: 0;
    min-width: 0;
    padding: var(--space-400);
  }

  legend {
    float: left;
    font-size: var(--font-size-subheading);
    font-weight: var(--font-weight-600);
    margin-bottom: var(--space-100);
    padding: 0;
    width: 100%;
  }

  p {
    clear: both;
    color: var(--sec-main);
    font-size: var(--font-size-label);
    margin: 0 0 var(--space-300);
  }

  .badge-options {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: repeat(auto-fit, minmax(5rem, 1fr));
  }

  .badge-background {
    align-items: center;
    display: flex;
    font-size: var(--font-size-label);
    gap: var(--space-300);
    justify-content: space-between;
    margin-bottom: var(--space-400);
  }

  .badge-option {
    align-items: center;
    background: var(--bg-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radii-400);
    color: var(--surface-on-container);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    justify-content: center;
    min-width: 0;
    overflow-wrap: anywhere;
    padding: var(--space-300) var(--space-200);
    position: relative;
    text-align: center;
  }

  .badge-option input {
    height: 100%;
    inset: 0;
    margin: 0;
    opacity: 0;
    position: absolute;
    width: 100%;
  }

  .badge-option:hover {
    background: var(--surface-container-hover);
  }

  .badge-option.selected {
    background: var(--primary-container);
    border-color: var(--primary-main);
    color: var(--primary-on-container);
  }

  .badge-option:has(input:focus-visible) {
    outline: var(--focus-ring-width) solid var(--primary-main);
    outline-offset: var(--focus-ring-offset);
  }

  .badge-option:has(input:disabled) {
    cursor: wait;
    opacity: var(--opacity-disabled);
  }

  .badge-option-mark {
    height: var(--space-800);
    width: var(--space-800);
  }
</style>
