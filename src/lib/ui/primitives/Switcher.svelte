<script lang="ts" module>
  export const settingsChoices = Symbol('settings choices');
</script>

<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  interface Props {
    items: { value: string; label: string; disabled?: boolean; labelClass?: ClassValue }[];
    value?: string;
    label: string;
    id?: string;
    name?: string;
    disabled?: boolean;
    required?: boolean;
    onValueChange?: (value: string) => void;
  }

  let {
    items,
    value = $bindable(''),
    label,
    id,
    name,
    disabled = false,
    required = false,
    onValueChange,
  }: Props = $props();
  const uid = $props.id();
  const index = $derived(items.findIndex((item) => item.value === value));
  let switcherElement: HTMLDivElement;
  const optionElements = $state<HTMLLabelElement[]>([]);
  let optionBounds = $state<Array<{ left: number; width: number }>>([]);
  const thumb = $derived(optionBounds[index]);

  $effect(() => {
    const root = switcherElement;
    const options = optionElements.slice(0, items.length);
    if (!root || options.length !== items.length) return;

    const measure = () => {
      optionBounds = options.map((option) => ({
        left: option.offsetLeft,
        width: option.offsetWidth,
      }));
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const option of options) observer.observe(option);
    return () => observer.disconnect();
  });
</script>

<div
  {id}
  bind:this={switcherElement}
  class="switcher"
  role="radiogroup"
  aria-label={label}
  aria-disabled={disabled}
>
  <span
    class="switcher-thumb"
    aria-hidden="true"
    hidden={index < 0 || !thumb}
    style:--switcher-thumb-left={`${thumb?.left ?? 0}px`}
    style:--switcher-thumb-width={`${thumb?.width ?? 0}px`}
  ></span>
  {#each items as item, i (item.value)}
    <label class="switcher-option" bind:this={optionElements[i]}>
      <input
        type="radio"
        name={name ?? uid}
        value={item.value}
        checked={value === item.value}
        disabled={disabled || item.disabled}
        {required}
        onchange={() => {
          value = item.value;
          onValueChange?.(item.value);
        }}
      />
      <span class={item.labelClass}>{item.label}</span>
    </label>
  {/each}
</div>

<style>
  .switcher {
    --switcher-pad: var(--space-050);

    background: color-mix(in oklab, var(--surface-on-container) 12%, transparent);
    border-radius: var(--radius-pill);
    box-sizing: border-box;
    display: flex;
    isolation: isolate;
    max-width: 100%;
    min-height: var(--control-height-small);
    padding: var(--switcher-pad);
    position: relative;
    width: max-content;
  }

  .switcher-thumb {
    background: var(--primary-container);
    border-radius: var(--radius-pill);
    box-shadow: var(--shadow-e100);
    inset-block: var(--switcher-pad);
    inset-inline-start: 0;
    pointer-events: none;
    position: absolute;
    translate: var(--switcher-thumb-left) 0;
    width: var(--switcher-thumb-width);
    z-index: 0;
  }

  .switcher-option {
    align-items: center;
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    cursor: pointer;
    display: flex;
    flex: 0 1 auto;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    justify-content: center;
    line-height: var(--line-height-small);
    min-height: calc(var(--control-height-small) - 2 * var(--switcher-pad));
    min-width: 0;
    opacity: var(--opacity-secondary);
    padding: 0 var(--space-300);
    position: relative;
    text-align: center;
    z-index: 1;
  }

  .switcher-option input {
    cursor: inherit;
    height: var(--target-hit);
    inset-block-start: calc(
      (var(--control-height-small) - 2 * var(--switcher-pad) - var(--target-hit)) / 2
    );
    inset-inline: 0;
    margin: 0;
    opacity: 0;
    position: absolute;
    width: 100%;
  }

  .switcher-option:has(input:checked) {
    color: var(--primary-on-container);
    opacity: 1;
  }

  .switcher-option:has(input:focus-visible) {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .switcher-option:has(input:disabled) {
    cursor: default;
    opacity: var(--opacity-disabled);
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .switcher-thumb {
      transition:
        translate var(--duration-fast) var(--ease-smooth-out),
        width var(--duration-fast) var(--ease-smooth-out);
    }
  }
</style>
