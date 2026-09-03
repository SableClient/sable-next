<script lang="ts" generics="Value extends string">
  import { RadioGroup } from 'bits-ui';

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

<RadioGroup.Root
  class="option-cards"
  value={value ?? ''}
  {disabled}
  aria-label={label}
  onValueChange={(next) => {
    const picked = options.find((option) => option.value === next);
    if (picked) onSelect(picked.value);
  }}
>
  {#each options as option (option.value)}
    {@const Icon = option.icon}
    <RadioGroup.Item
      value={option.value}
      disabled={disabled || option.disabled}
      class="option-card sable-choice"
      data-selected={option.value === value ? 'true' : undefined}
    >
      {#if Icon}<span class="option-card-icon" aria-hidden="true"><Icon /></span>{/if}
      <span class="option-card-text">
        <span class="option-card-label">{option.label}</span>
        {#if option.hint}<span class="option-card-hint">{option.hint}</span>{/if}
      </span>
    </RadioGroup.Item>
  {/each}
</RadioGroup.Root>

<style>
  :global(.option-cards) {
    display: grid;
    gap: var(--space-200);
  }

  :global(.option-card) {
    align-items: center;
    background: var(--sable-surface-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radii-400);
    color: inherit;
    cursor: pointer;
    display: flex;
    gap: var(--space-300);
    padding: var(--space-300);
    position: relative;
    text-align: left;
    width: 100%;
  }

  :global(.option-card:focus-visible) {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  :global(.option-card[data-disabled]) {
    cursor: not-allowed;
    opacity: var(--opacity-disabled);
  }

  :global(.option-card:hover:not([data-disabled])) {
    background: var(--sable-bg-container-hover);
  }

  :global(.option-card-icon) {
    align-items: center;
    display: inline-flex;
    flex: none;
  }

  :global(.option-card-icon svg) {
    height: var(--size-x500);
    width: var(--size-x500);
  }

  :global(.option-card-text) {
    display: grid;
    gap: var(--space-100);
    min-width: 0;
  }

  :global(.option-card-label) {
    font-weight: var(--font-weight-600);
  }

  :global(.option-card-hint) {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    line-height: var(--line-height-small);
  }

  :global(.option-card[data-selected='true'] .option-card-hint) {
    color: inherit;
  }
</style>
