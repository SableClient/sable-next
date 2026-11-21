<script lang="ts">
  import WarningIcon from 'phosphor-svelte/lib/WarningIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import type { SearchToken } from './search-query';

  interface Props {
    chip: SearchToken;
    label: string;
    unresolved: boolean;
    onEdit: () => void;
    onRemove: () => void;
  }

  let { chip, label, unresolved, onEdit, onRemove }: Props = $props();

  let filter = $derived(`${chip.negated ? '-' : ''}${chip.operator}:${label}`);
</script>

<li class={['chip', { negated: chip.negated, unresolved }]}>
  <button
    class="chip-edit"
    type="button"
    aria-label={i18n.t('search.editFilter', { filter })}
    onclick={onEdit}
  >
    {#if unresolved}<WarningIcon />{/if}
    <span class="chip-operator">{chip.negated ? '-' : ''}{chip.operator}:</span>
    <span class="chip-value">{label}</span>
    {#if unresolved}
      <span class="screen-reader-only">{i18n.t('search.chipUnresolved')}</span>
    {/if}
  </button>
  <button
    class="chip-remove"
    type="button"
    aria-label={i18n.t('search.removeFilter', { filter })}
    onclick={onRemove}
  >
    <XIcon />
  </button>
</li>

<style>
  .chip {
    align-items: center;
    background: var(--sec-container);
    border: var(--border-width) solid var(--sec-container-line);
    border-radius: var(--radius-pill);
    color: var(--sec-on-container);
    display: inline-flex;
    font-size: var(--font-size-small);
    gap: var(--space-050);
    max-width: 100%;
    min-width: 0;
    padding-inline-end: var(--space-050);
  }

  .chip-edit {
    align-items: center;
    background: none;
    border: 0;
    border-radius: inherit;
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    gap: var(--space-050);
    min-width: 0;
    padding: 0;
    padding-inline-start: var(--space-200);
  }

  .chip-edit:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .chip.negated {
    background: var(--crit-container);
    border-color: var(--crit-container-line);
    color: var(--crit-on-container);
  }

  .chip.unresolved {
    background: var(--warn-container);
    border-color: var(--warn-container-line);
    border-style: dashed;
    color: var(--warn-on-container);
  }

  .chip-operator {
    flex: 0 0 auto;
    opacity: 0.75;
  }

  .chip.unresolved .chip-operator {
    opacity: 1;
  }

  .chip-value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-remove {
    --target: 1.25rem;

    align-items: center;
    background: none;
    border: 0;
    border-radius: var(--radius-pill);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 0 0 auto;
    font-size: inherit;
    height: var(--target);
    justify-content: center;
    padding: 0;
    position: relative;
    width: var(--target);
  }

  .chip-remove::after {
    border-radius: inherit;
    content: '';
    inset: calc((var(--target) - var(--target-hit)) / 2);
    position: absolute;
  }

  .chip-remove:hover,
  .chip-remove:focus-visible {
    background: var(--sec-container-hover);
  }

  .chip.negated .chip-remove:hover,
  .chip.negated .chip-remove:focus-visible {
    background: var(--crit-container-hover);
  }

  .chip.unresolved .chip-remove:hover,
  .chip.unresolved .chip-remove:focus-visible {
    background: var(--warn-container-hover);
  }

  @media (pointer: coarse) {
    .chip-edit {
      position: relative;
    }

    .chip-edit::after {
      content: '';
      inset: calc((100% - var(--target-hit)) / 2) 0;
      position: absolute;
    }
  }
</style>
