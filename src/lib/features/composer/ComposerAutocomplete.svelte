<script lang="ts">
  import '#lib/ui/primitives/menu.css';
  import { i18n } from '#lib/i18n.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  import type { Suggestion } from './autocomplete';

  interface Props {
    id: string;
    optionId: (index: number) => string;
    heading: string;
    suggestions: readonly Suggestion[];
    active: number;
    onSelect: (suggestion: Suggestion) => void;
  }

  let { id, optionId, heading, suggestions, active, onSelect }: Props = $props();

  function keepActiveInView(node: HTMLElement): void {
    node.querySelector(`[data-index="${String(active)}"]`)?.scrollIntoView({ block: 'nearest' });
  }
</script>

<div class="autocomplete">
  <p class="heading" id="{id}-heading">{heading}</p>
  {#if suggestions.length === 0}
    <p class="empty">{$i18n.t('composer.noSuggestions')}</p>
  {/if}
  <ul {id} role="listbox" aria-labelledby="{id}-heading" {@attach keepActiveInView}>
    {#if suggestions.length > 0}
      {#each suggestions as suggestion, index (suggestion.id)}
        <li role="presentation">
          <button
            type="button"
            class="menu-item option selection-highlight"
            id={optionId(index)}
            role="option"
            tabindex="-1"
            data-index={index}
            aria-selected={index === active}
            onmousedown={(event: MouseEvent) => {
              event.preventDefault();
            }}
            onclick={() => {
              onSelect(suggestion);
            }}
          >
            {#if suggestion.imageUrl}
              <MediaImage
                class="emote"
                source={suggestion.imageUrl}
                alt=""
                width={24}
                height={24}
                original
              />
            {:else}
              <Avatar size="small" src={suggestion.avatarUrl} name={suggestion.label} />
            {/if}
            <span class="label">{suggestion.label}</span>
            {#if suggestion.detail}<span class="detail">{suggestion.detail}</span>{/if}
          </button>
        </li>
      {/each}
    {/if}
  </ul>
</div>

<style>
  .autocomplete {
    background: var(--bg-container);
    border: var(--border-width) solid var(--bg-container-line);
    border-radius: var(--radius);
    bottom: calc(100% + 0.5rem);
    box-shadow: var(--shadow-float);
    display: flex;
    flex-direction: column;
    left: 0;
    max-height: 30dvh;
    overflow: hidden;
    position: absolute;
    right: 0;
    z-index: var(--layer-popover);
  }

  .heading {
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    margin: 0;
    padding: var(--space-200) var(--space-300) var(--space-100);
  }

  .empty {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: var(--space-100) var(--space-300) var(--space-300);
  }

  ul {
    --radius-inner: var(--radii-300);

    display: grid;
    flex: 1 1 auto;
    gap: var(--space-100);
    list-style: none;
    margin: 0;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-200);
  }

  .option :global(.emote) {
    aspect-ratio: 1;
    flex: 0 0 auto;
    height: var(--avatar-size-300);
    width: var(--avatar-size-300);
  }

  .option :global(.emote .media-image-content) {
    object-fit: contain;
  }

  .label {
    flex: 1 1 auto;
  }

  .label,
  .detail {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .detail {
    color: var(--surface-var-on-container);
    flex: 0 1 auto;
    font-size: var(--font-size-small);
  }
</style>
