<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';
  import LinkSimpleIcon from 'phosphor-svelte/lib/LinkSimpleIcon';
  import ArrowsClockwiseIcon from 'phosphor-svelte/lib/ArrowsClockwiseIcon';

  import '#lib/ui/primitives/menu.css';
  import { i18n } from '#lib/i18n.js';
  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';
  import { suppressBanners } from '#lib/ui/banner-suppression.svelte.js';

  export type OfferChoice = 'once' | 'always';

  interface Props {
    id: string;
    optionId: (index: number) => string;
    heading: string;
    target: string;
    choices: readonly { choice: OfferChoice; label: string; hint?: string }[];
    active: number;
    onChoose: (choice: OfferChoice) => void;
  }

  let { id, optionId, heading, target, choices, active, onChoose }: Props = $props();

  $effect(suppressBanners);
</script>

<div
  class="offer composer-autocomplete"
  in:fly={{ y: 4, duration: motionMs(MOTION_MS.quick), easing: cubicOut }}
>
  <p class="heading" id="{id}-heading">
    <span class="title">{heading}</span>
    <span class="target">{target}</span>
  </p>
  <ul {id} role="listbox" aria-labelledby="{id}-heading">
    {#each choices as { choice, label, hint }, index (choice)}
      <li role="presentation" class={{ divided: choice === 'always' }}>
        <button
          type="button"
          class="menu-item option selection-highlight"
          id={optionId(index)}
          role="option"
          tabindex="-1"
          aria-selected={index === active}
          onmousedown={(event: MouseEvent) => {
            event.preventDefault();
          }}
          onclick={() => {
            onChoose(choice);
          }}
        >
          {#if choice === 'once'}
            <LinkSimpleIcon size="1.125rem" aria-hidden="true" />
          {:else}
            <ArrowsClockwiseIcon size="1.125rem" aria-hidden="true" />
          {/if}
          <span class="text">
            <span class="label">{label}</span>
            {#if hint}
              <span class="hint">{hint}</span>
            {/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>
  <p class="keys" aria-hidden="true">
    <span><kbd>Tab</kbd> {i18n.t('composer.offerKeyLink')}</span>
    <span><kbd>Esc</kbd> {i18n.t('composer.offerKeyDismiss')}</span>
    <span><kbd>Enter</kbd> {i18n.t('composer.offerKeySend')}</span>
  </p>
</div>

<style>
  .offer {
    --offer-muted: color-mix(
      in srgb,
      var(--surface-var-on-container) 72%,
      var(--surface-container)
    );
    --offer-rule: color-mix(in srgb, var(--surface-var-on-container) 30%, var(--surface-container));

    background: var(--surface-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    bottom: calc(100% + 0.5rem);
    box-shadow: var(--shadow-float);
    color: var(--surface-on-container);
    display: flex;
    flex-direction: column;
    inset-inline: 0;
    position: absolute;
    z-index: var(--layer-overlay);
  }

  .heading {
    align-items: baseline;
    display: flex;
    gap: var(--space-200);
    margin: 0;
    min-width: 0;
    padding: var(--space-200) var(--space-300) var(--space-100);
  }

  .title {
    color: var(--surface-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  .target {
    color: var(--offer-muted);
    font-size: var(--font-size-small);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  ul {
    --radius-inner: var(--radii-300);

    display: grid;
    gap: var(--space-100);
    grid-template-columns: minmax(0, 1fr);
    list-style: none;
    margin: 0;
    padding: var(--space-200);
  }

  .option {
    --menu-item-gap: var(--space-300);
  }

  .option:hover {
    background: var(--surface-container-hover);
    color: var(--surface-on-container);
  }

  .option[aria-selected='true'] {
    background: var(--surface-container-active);
    color: var(--surface-on-container);
  }

  .divided {
    border-block-start: var(--border-width) solid var(--offer-rule);
    padding-block-start: var(--space-100);
  }

  .text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
  }

  .label {
    font-size: var(--font-size-label);
  }

  .hint {
    color: var(--offer-muted);
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .keys {
    border-block-start: var(--border-width) solid var(--offer-rule);
    color: var(--offer-muted);
    display: flex;
    flex-wrap: wrap;
    font-size: var(--font-size-small);
    gap: var(--space-100) var(--space-300);
    margin: 0;
    padding: var(--space-150) var(--space-300);
  }

  kbd {
    background: var(--surface-var-container);
    border-radius: var(--radii-300);
    color: var(--surface-on-container);
    font-family: var(--font-family-mono);
    font-size: var(--font-size-small);
    font-variant-ligatures: none;
    padding: 0 var(--space-100);
  }
</style>
