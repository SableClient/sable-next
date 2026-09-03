<script lang="ts">
  import '#lib/ui/primitives/menu.css';
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
            class="sable-menu-item option sable-highlight"
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
              <MediaImage source={suggestion.imageUrl} alt="" width={24} height={24} original />
            {:else}
              <Avatar size="small" src={suggestion.avatarUrl} name={suggestion.label} />
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
    border: var(--border-width) solid var(--sable-bg-container-line);
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
    padding: var(--space-150) var(--space-250);
  }

  .heading {
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    text-transform: uppercase;
  }

  .hint {
    border-top: var(--border-width) solid var(--sable-surface-container-line);
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: var(--space-250);
  }

  ul {
    list-style: none;
    margin: 0;
    max-height: 13rem;
    overflow-y: auto;
    padding: var(--space-100);
  }

  .text {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .sigil {
    color: var(--sable-primary-main);
    margin-right: var(--space-150);
  }

  .key {
    background: var(--sable-surface-var-container);
    border-radius: calc(var(--radius) - 0.25rem);
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    padding: 0 var(--space-100);
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
