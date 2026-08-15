<script lang="ts" generics="Value extends string">
  import type { OptionCard } from './option-card';

  interface Props {
    label: string;
    options: readonly OptionCard<Value>[];
    /** `null` leaves every card unchecked, for a value none of them name. */
    value: Value | null;
    disabled?: boolean;
    onSelect: (value: Value) => void;
  }

  let { label, options, value, disabled = false, onSelect }: Props = $props();
</script>

<div class="option-cards" role="radiogroup" aria-label={label}>
  {#each options as option (option.value)}
    {@const Icon = option.icon}
    {@const selected = option.value === value}
    <button
      class="option-card"
      class:selected
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled || option.disabled}
      onclick={() => {
        onSelect(option.value);
      }}
    >
      {#if Icon}<span class="option-card-icon" aria-hidden="true"><Icon /></span>{/if}
      <span class="option-card-text">
        <span class="option-card-label">{option.label}</span>
        {#if option.hint}<span class="option-card-hint">{option.hint}</span>{/if}
      </span>
    </button>
  {/each}
</div>

<style>
  .option-cards {
    display: grid;
    gap: var(--space-1);
  }

  .option-card {
    align-items: center;
    background: var(--sable-surface-container);
    border: 1px solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--space-2);
    padding: var(--space-2);
    text-align: left;
    width: 100%;
  }

  .option-card:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .option-card:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .option-card:hover:not(:disabled) {
    background: var(--sable-bg-container-hover);
  }

  .option-card.selected {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-main);
    color: var(--sable-primary-on-container);
  }

  .option-card-icon {
    align-items: center;
    display: inline-flex;
    flex: none;
  }

  .option-card-icon :global(svg) {
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  .option-card-text {
    display: grid;
    gap: calc(var(--space-1) / 2);
    min-width: 0;
  }

  .option-card-label {
    font-weight: var(--font-weight-medium);
  }

  .option-card-hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-body);
  }

  .option-card.selected .option-card-hint {
    color: inherit;
  }
</style>
