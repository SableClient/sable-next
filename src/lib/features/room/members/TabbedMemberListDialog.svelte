<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';

  import type { MemberView } from '#src/generated/protocol';

  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';

  import MemberIdentityRow from './MemberIdentityRow.svelte';

  interface Props {
    open?: boolean;
    title: string;
    tabs: readonly T[];
    tabKey: (tab: T) => string;
    userIds: (tab: T) => readonly string[];
    members: readonly MemberView[];
    active?: number;
    onMemberProfile?: (userId: string, anchor: HTMLElement) => void;
    tab: Snippet<[T]>;
  }

  let {
    open = $bindable(false),
    title,
    tabs,
    tabKey,
    userIds,
    members,
    active = $bindable(0),
    onMemberProfile,
    tab,
  }: Props = $props();
  let selected = $derived<T | undefined>(tabs[Math.min(active, tabs.length - 1)]);
</script>

<DialogFrame bind:open variant="verification" label={title}>
  <div class="member-list-dialog">
    <h2>{title}</h2>
    <div class="tabs" role="tablist" aria-label={title}>
      {#each tabs as item, index (tabKey(item))}
        <Button
          size="small"
          variant="ghost"
          class="member-list-tab choice"
          role="tab"
          aria-selected={selected !== undefined && tabKey(item) === tabKey(selected)}
          onclick={() => {
            active = index;
          }}
        >
          {@render tab(item)}
          {userIds(item).length}
        </Button>
      {/each}
    </div>
    {#if selected !== undefined}
      <ul>
        {#each userIds(selected) as userId (userId)}
          <li>
            <MemberIdentityRow {userId} {members} onProfile={onMemberProfile} />
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</DialogFrame>

<style>
  .member-list-dialog {
    display: grid;
    gap: var(--space-300);
    width: min(24rem, calc(100vw - 2rem));
  }

  h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
  }

  :where(.tabs) :global(.member-list-tab) {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius-pill);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    padding: var(--space-050) var(--space-200);
  }

  :where(.tabs) :global(.member-list-tab em) {
    font-style: normal;
  }

  ul {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    max-height: 16rem;
    overflow-y: auto;
    padding: 0;
  }
</style>
