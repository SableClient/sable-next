<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { tick } from 'svelte';
  import SupporterMark from './SupporterMark.svelte';
  import SupporterBadge from './SupporterBadge.svelte';
  import ColorSetting from '#lib/features/settings/ColorSetting.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import {
    isSupporterColor,
    supporterColor,
    supporterAppearance,
    SUPPORTER_VARIANTS,
    SUPPORTER_SHAPES,
    variantAvailable,
    type SupporterAppearance,
  } from './variants.js';

  let {
    value,
    name: donorName,
    tier = null,
    disabled = false,
    onChange,
  }: {
    value: SupporterAppearance;
    name?: string;
    tier?: string | null;
    disabled?: boolean;
    onChange: (patch: Partial<SupporterAppearance>) => void | Promise<void>;
  } = $props();
  const name = $props.id();
  const defaults = supporterAppearance();
  let iconVariants = $derived(
    SUPPORTER_VARIANTS.filter((variant) => variant !== 'custom' && variantAvailable(variant, tier))
  );
  const colorLabels = {
    color: 'customColor',
    backgroundColor: 'backgroundColor',
    cardColor: 'cardColor',
    buttonColor: 'buttonColor',
  };
  type ColorKey = keyof typeof colorLabels;
  let draft = $derived({ ...value });

  async function update(patch: Partial<SupporterAppearance>): Promise<void> {
    draft = { ...draft, ...patch };
    try {
      await onChange(patch);
    } finally {
      await tick();
      draft = { ...value };
    }
  }

  async function commitColor(key: ColorKey, next = draft[key]): Promise<void> {
    if (!isSupporterColor(next)) return;
    const normalized = supporterColor(next, defaults[key]);
    if (normalized !== value[key]) await update({ [key]: normalized });
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
    <SupporterBadge label={$i18n.t('supporter.donor')} name={donorName} isOwnBadge {...draft} />
  </div>
{/snippet}

<fieldset class="badge-picker" {disabled}>
  <legend>{$i18n.t('supporter.chooseBadge')}</legend>
  <p>{$i18n.t('supporter.chooseBadgeHint')}</p>
  <div class="badge-options">
    {#each iconVariants as variant (variant)}
      <label class="badge-option" class:selected={draft.variant === variant}>
        <input
          type="radio"
          {name}
          value={variant}
          bind:group={draft.variant}
          onchange={() => void update({ variant })}
        />
        <span class="badge-option-mark"><SupporterMark {...draft} {variant} /></span>
        <span
          >{variant === 'gold' || variant === 'ghost' || variant === 'evil'
            ? $i18n.t(`supporter.colors.${variant}`)
            : $i18n.t(`settings.appIcons.${variant}`)}</span
        >
      </label>
    {/each}
  </div>
  <div class="custom-badge">
    <label class="custom-choice">
      <input
        type="radio"
        {name}
        value="custom"
        bind:group={draft.variant}
        onchange={() => void update({ variant: 'custom' })}
      />
      <span class="custom-copy"
        ><strong>{$i18n.t('supporter.colors.custom')}</strong><small
          >{$i18n.t('supporter.customColorHint')}</small
        ></span
      >
    </label>
    {#if draft.variant === 'custom'}
      {@render colorEditor(['color'])}
    {/if}
  </div>
  <fieldset class="shape-picker">
    <legend>{$i18n.t('supporter.backgroundShape')}</legend>
    <div class="shape-options badge-options">
      {#each SUPPORTER_SHAPES as shape (shape)}
        <label class="badge-option" class:selected={draft.shape === shape}>
          <input
            type="radio"
            name={`${name}-shape`}
            value={shape}
            bind:group={draft.shape}
            onchange={() => void update({ shape })}
          />
          <span class="badge-option-mark"><SupporterMark {...draft} {shape} /></span>
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

  .custom-choice {
    align-items: center;
    cursor: pointer;
    display: flex;
    gap: var(--space-300);
  }

  .custom-choice input {
    accent-color: var(--primary-main);
    flex-shrink: 0;
    margin: 0;
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
