<script lang="ts">
  import type { UserDirectoryEntryView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { keepInView } from '#lib/ui/keep-in-view.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import '#lib/ui/primitives/menu.css';
  import { scrollHint } from '#lib/ui/scroll-hint.js';
  import { isComposingKey } from '#lib/ui/shortcuts/binding.js';

  interface Props {
    /** The listbox id the field names in `aria-controls`. */
    id: string;
    entries: UserDirectoryEntryView[];
    disabled?: boolean;
    onSelect: (userId: string) => void;
  }

  let { id, entries, disabled = false, onSelect }: Props = $props();

  let activeId = $state<string | null>(null);
  let active = $derived(entries.findIndex((entry) => entry.user_id === activeId));

  /** The option the field names in `aria-activedescendant`. */
  export function activeOptionId(): string | undefined {
    return active === -1 ? undefined : `${id}-${String(active)}`;
  }

  /** Moves through the entries from the field that owns them; true when the key was used. */
  export function handleKey(event: KeyboardEvent): boolean {
    if (isComposingKey(event)) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const from = active === -1 && event.key === 'ArrowUp' ? 0 : active;
      const step = event.key === 'ArrowDown' ? 1 : entries.length - 1;
      activeId = entries[(from + step) % entries.length]?.user_id ?? null;
    } else if (event.key === 'Enter' && entries[active] && !disabled) {
      onSelect(entries[active].user_id);
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }
</script>

<ul
  {id}
  class="suggestions"
  role="listbox"
  aria-label={i18n.t('findOrJoin.people')}
  {@attach keepInView(() => active)}
  {@attach scrollHint}
>
  {#each entries as entry, index (entry.user_id)}
    {@const name = entry.display_name ?? entry.user_id}
    <li role="presentation">
      <button
        type="button"
        class="menu-item selection-highlight"
        id="{id}-{index}"
        role="option"
        tabindex="-1"
        data-index={index}
        aria-selected={index === active}
        {disabled}
        onclick={() => {
          onSelect(entry.user_id);
        }}
      >
        <Avatar size="small" id={entry.user_id} src={entry.avatar_url} {name} />
        <span class="identity">
          <span class="name">{name}</span>
          <span class="user-id">{entry.user_id}</span>
        </span>
      </button>
    </li>
  {/each}
</ul>

<style>
  .suggestions {
    display: grid;
    list-style: none;
    margin: 0;
    max-height: 16rem;
    overflow: auto;
    padding: 0;
  }

  .suggestions :global(.menu-item) {
    --menu-item-height: var(--control-height-500);
    --menu-item-gap: var(--space-200);
  }

  .identity {
    display: grid;
    min-width: 0;
  }

  .name,
  .user-id {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .user-id {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
