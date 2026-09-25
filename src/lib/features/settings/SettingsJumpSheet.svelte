<script lang="ts">
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';

  import { i18n } from '#lib/i18n.js';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';
  import type { OutlineTracker } from './settings-outline.svelte.js';

  interface Props {
    outline: OutlineTracker;
    title: string;
  }

  let { outline, title }: Props = $props();
  let open = $state(false);

  function jump(id: string): void {
    open = false;
    requestAnimationFrame(() => {
      outline.jump(id);
    });
  }
</script>

<button
  type="button"
  class="jump-trigger"
  aria-haspopup="dialog"
  aria-expanded={open}
  onclick={() => {
    open = true;
  }}
>
  <span class="jump-trigger-label">{title}</span>
  <CaretDownIcon aria-hidden="true" />
</button>

<BottomSheet
  bind:open
  label={$i18n.t('settings.outlineLabel', { section: title })}
  closeLabel={$i18n.t('settings.close')}
>
  <div class="jump-sheet">
    <p class="jump-title">{title}</p>
    <ul class="jump-list">
      {#each outline.entries as entry (entry.id)}
        {@const active = entry.id === outline.activeId}
        <li>
          <button
            type="button"
            class="jump-item"
            aria-current={active ? 'location' : undefined}
            onclick={() => {
              jump(entry.id);
            }}
          >
            <span class="jump-label">{entry.label}</span>
            {#if active}<CheckIcon aria-hidden="true" />{/if}
          </button>
        </li>
      {/each}
    </ul>
    <p class="jump-hint">{$i18n.t('settings.copyLinkHint')}</p>
  </div>
</BottomSheet>

<style>
  .jump-trigger {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    gap: var(--space-100);
    margin-inline-start: calc(var(--space-200) * -1);
    max-width: 100%;
    min-height: max(var(--control-height-medium), var(--target-hit));
    min-width: 0;
    padding: 0 var(--space-200);
  }

  .jump-trigger:hover {
    background: var(--surface-container-hover);
  }

  .jump-trigger:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .jump-trigger-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .jump-trigger :global(svg) {
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    height: var(--icon-size-small);
    transition: transform var(--duration-fast) var(--ease-smooth-out);
    width: var(--icon-size-small);
  }

  .jump-trigger[aria-expanded='true'] :global(svg) {
    transform: rotate(180deg);
  }

  .jump-sheet {
    display: grid;
    gap: var(--space-200);
  }

  .jump-title {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
    padding: 0 var(--space-300);
  }

  .jump-list {
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .jump-item {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-label);
    gap: var(--space-300);
    min-height: var(--control-height-large);
    padding: 0 var(--space-300);
    text-align: start;
    width: 100%;
  }

  .jump-item:hover {
    background: var(--surface-container-hover);
  }

  .jump-item:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .jump-item[aria-current='location'] {
    color: var(--surface-on-container);
    font-weight: var(--font-weight-medium);
  }

  .jump-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .jump-item :global(svg) {
    color: var(--primary-main);
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .jump-hint {
    color: var(--surface-var-on-container);
    display: none;
    font-size: var(--font-size-small);
    margin: 0;
    padding: 0 var(--space-300);
  }

  @media (pointer: coarse) {
    .jump-hint {
      display: block;
    }
  }
</style>
