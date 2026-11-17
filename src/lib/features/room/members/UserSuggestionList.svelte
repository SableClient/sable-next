<script lang="ts">
  import type { UserDirectoryEntryView } from '#src/generated/protocol';

  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import '#lib/ui/primitives/menu.css';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  interface Props {
    entries: UserDirectoryEntryView[];
    onSelect: (userId: string) => void;
  }

  let { entries, onSelect }: Props = $props();
</script>

<ul class="suggestions" {@attach scrollHint}>
  {#each entries as entry (entry.user_id)}
    {@const name = entry.display_name ?? entry.user_id}
    <li>
      <button
        type="button"
        class="menu-item"
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
