<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  import type { Suggestion } from './autocomplete';

  interface Props {
    id: string;
    optionId: (index: number) => string;
    sigil: string;
    heading: string;
    suggestions: readonly Suggestion[];
    active: number;
    onSelect: (suggestion: Suggestion) => void;
  }

  let { id, optionId, sigil, heading, suggestions, active, onSelect }: Props = $props();

  function keepActiveInView(node: HTMLElement): void {
    node.querySelector(`[data-index="${String(active)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
</script>

<div class="autocomplete">
  <p class="heading" id="{id}-heading">
    <span class="sigil" aria-hidden="true">{sigil}</span>{heading}
  </p>
  {#if suggestions.length === 0}
    <p class="empty">{$i18n.t('composer.noSuggestions')}</p>
  {/if}
  <ul {id} role="listbox" aria-labelledby="{id}-heading" {@attach keepActiveInView}>
    {#if suggestions.length > 0}
      {#each suggestions as suggestion, index (suggestion.id)}
        <li role="presentation">
          <button
            type="button"
            class="option"
            class:active={index === active}
            id={optionId(index)}
            role="option"
            tabindex="-1"
            data-index={index}
            aria-selected={index === active}
            onmousedown={(event: MouseEvent) => {
              // The field must keep focus, or the caret is gone before insertion.
              event.preventDefault();
            }}
            onclick={() => {
              onSelect(suggestion);
            }}
          >
            {#if suggestion.imageUrl}
              <MediaImage source={suggestion.imageUrl} alt="" width={24} height={24} />
            {:else}
              <Avatar
                size="small"
                src={suggestion.avatarUrl}
                initials={suggestion.label.slice(0, 1)}
              />
            {/if}
            <span class="text">
              <span class="label">{suggestion.label}</span>
              {#if suggestion.detail}<span class="detail">{suggestion.detail}</span>{/if}
            </span>
            {#if index === active}<span class="key" aria-hidden="true">⏎</span>{/if}
          </button>
        </li>
      {/each}
    {/if}
  </ul>
  <p class="hint">{$i18n.t('composer.autocompleteHint')}</p>
</div>

<style>
  .autocomplete {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    bottom: calc(100% + 0.5rem);
    box-shadow: var(--shadow-float);
    left: 0;
    max-width: 22rem;
    overflow: hidden;
    position: absolute;
    width: max-content;
    z-index: var(--layer-popover);
  }

  .heading,
  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: 0.375rem 0.625rem;
  }

  .heading {
    border-bottom: 1px solid var(--sable-surface-container-line);
    text-transform: uppercase;
  }

  .hint {
    border-top: 1px solid var(--sable-surface-container-line);
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: 0.625rem;
  }

  ul {
    list-style: none;
    margin: 0;
    max-height: 13rem;
    overflow-y: auto;
    padding: 0.25rem;
  }

  .option {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: calc(var(--radius) - 0.125rem);
    color: inherit;
    cursor: pointer;
    display: flex;
    gap: var(--space-1);
    padding: 0.3125rem 0.375rem;
    text-align: left;
    width: 100%;
  }

  .option:hover,
  .option.active {
    background: var(--sable-surface-container-hover);
  }

  .text {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .sigil {
    color: var(--sable-primary-main);
    margin-right: 0.375rem;
  }

  .key {
    background: var(--sable-surface-var-container);
    border-radius: calc(var(--radius) - 0.25rem);
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    padding: 0 0.25rem;
  }

  .label,
  .detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
