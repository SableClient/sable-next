<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import type { Component } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import ResponsivePopover from '#lib/ui/primitives/ResponsivePopover.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import { COLOR_PRESETS } from './color-presets';
  import { normalizeMfmHex } from './time-markup';

  interface Props {
    label: string;
    icon: Component;
    value: string | null;
    removable: boolean;
    onPick: (value: string | null) => void;
  }

  let { label, icon: Icon, value, removable, onPick }: Props = $props();

  let open = $state(false);
  let draft = $state('');
  let custom = $derived(normalizeMfmHex(draft.trim()));

  function pick(next: string | null): void {
    open = false;
    onPick(next);
  }
</script>

<ResponsivePopover
  bind:open
  class="composer-color-popover"
  side="top"
  align="start"
  sideOffset={6}
  {label}
  closeLabel={$i18n.t('composer.colorClose')}
  onOpenChange={(next) => {
    if (next) draft = value ?? '';
  }}
  onCloseAutoFocus={(event) => {
    event.preventDefault();
  }}
>
  {#snippet trigger({ props })}
    <IconButton
      {...props}
      variant="ghost"
      size="small"
      class="format-button choice color-trigger"
      {label}
      aria-pressed={value !== null}
    >
      <Icon />
      <span
        class="color-bar"
        class:set={value !== null}
        style:background={value ?? undefined}
        aria-hidden="true"
      ></span>
    </IconButton>
  {/snippet}

  {#snippet children(sheet: boolean)}
    <div class="color-picker" class:sheet>
      <p class="color-title">{label}</p>
      <div class="swatches" role="group" aria-label={$i18n.t('composer.colorPresets')}>
        {#each COLOR_PRESETS as preset (preset)}
          <button
            type="button"
            class="swatch"
            style:background={preset}
            aria-label={preset}
            aria-pressed={value === preset}
            onclick={() => {
              pick(preset);
            }}
          >
            {#if value === preset}<CheckIcon aria-hidden="true" weight="bold" />{/if}
          </button>
        {/each}
      </div>
      <form
        class="custom"
        onsubmit={(event) => {
          event.preventDefault();
          if (custom) pick(custom);
        }}
      >
        <span class="custom-preview" style:background={custom} aria-hidden="true"></span>
        <TextInput
          bind:value={draft}
          aria-label={$i18n.t('composer.colorHex')}
          placeholder="#RRGGBB"
          maxlength={7}
          spellcheck={false}
          autocomplete="off"
        />
        <Button type="submit" size="small" disabled={!custom}
          >{$i18n.t('composer.colorApply')}</Button
        >
      </form>
      {#if removable && value !== null}
        <Button
          variant="ghost"
          size="small"
          onclick={() => {
            pick(null);
          }}
        >
          {$i18n.t('composer.colorRemove')}
        </Button>
      {/if}
    </div>
  {/snippet}
</ResponsivePopover>

<style>
  :global(.responsive-popover.composer-color-popover) {
    width: auto;
  }

  :global(.color-trigger) {
    flex-direction: column;
  }

  .color-bar {
    background: var(--surface-var-on-container);
    border-radius: var(--radii-200);
    bottom: var(--space-100);
    height: var(--space-050);
    left: 50%;
    opacity: 0.35;
    position: absolute;
    transform: translateX(-50%);
    width: var(--icon-size-small);
  }

  .color-bar.set {
    box-shadow: 0 0 0 var(--border-width) var(--surface-container-line);
    opacity: 1;
  }

  .color-picker {
    display: grid;
    gap: var(--space-300);
    padding: var(--space-300);
    width: min(16rem, calc(100vw - 2rem));
  }

  .color-picker.sheet {
    padding: 0 var(--space-400) var(--space-400);
    width: auto;
  }

  .color-title {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-600);
    margin: 0;
  }

  .swatches {
    display: grid;
    gap: var(--space-150);
    grid-template-columns: repeat(6, 1fr);
  }

  .swatch {
    align-items: center;
    aspect-ratio: 1;
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radii-300);
    color: var(--bg-container);
    cursor: pointer;
    display: flex;
    justify-content: center;
    padding: 0;
  }

  .swatch :global(svg) {
    filter: drop-shadow(0 0 1px var(--bg-on-container));
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .swatch:hover {
    transform: scale(1.08);
  }

  .swatch:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .custom {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .custom :global(.text-input) {
    flex: 1;
    font-family: var(--font-family-mono);
    min-width: 0;
    text-transform: uppercase;
  }

  .custom-preview {
    background: repeating-conic-gradient(var(--surface-container-line) 0 25%, transparent 0 50%)
      50% / var(--space-200) var(--space-200);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radii-300);
    flex: none;
    height: var(--size-x500);
    width: var(--size-x500);
  }

  @media (prefers-reduced-motion: no-preference) {
    .swatch {
      transition: transform var(--duration-fast) var(--ease-smooth-out);
    }
  }
</style>
