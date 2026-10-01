<script module lang="ts">
  export interface TypingUser {
    userId: string;
    name: string | null;
  }
</script>

<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import TypingDots from '#lib/ui/primitives/TypingDots.svelte';

  interface Props {
    users: readonly TypingUser[];
    onProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let { users, onProfile }: Props = $props();
  let label = $derived.by(() => {
    if (users.length === 0) return null;
    if (users.slice(0, 3).some((user) => user.name === null))
      return $i18n.t('timeline.unknownTyping');
    const name1 = '\u00000\u0000';
    const name2 = '\u00001\u0000';
    const name3 = '\u00002\u0000';
    if (users.length === 1) return $i18n.t('timeline.oneTyping', { name: name1 });
    if (users.length === 2) return $i18n.t('timeline.twoTyping', { name1, name2 });
    if (users.length === 3) return $i18n.t('timeline.threeTyping', { name1, name2, name3 });
    return $i18n.t('timeline.manyTyping', { name1, name2, count: users.length - 2 });
  });
  let parts = $derived(label?.split('\u0000') ?? []);
</script>

<div class="typing" aria-live="polite" role="status">
  {#if label}
    <TypingDots />
    <span class="label"
      >{#each parts as part, index (index)}{#if index % 2 === 0}{part}{:else}{@const user =
            users[Number(part)]}{#if onProfile}<button
              type="button"
              aria-label={$i18n.t('timeline.senderProfile', { name: user.name })}
              onclick={(event) => onProfile(user.userId, event.currentTarget)}>{user.name}</button
            >{:else}{user.name}{/if}{/if}{/each}</span
    >
  {/if}
</div>

<style>
  .typing {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-150);
    line-height: 1.125rem;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  button {
    background: none;
    border: 0;
    color: inherit;
    cursor: pointer;
    font: inherit;
    padding: 0;
  }

  button:hover {
    text-decoration: underline;
  }

  button:focus-visible {
    border-radius: var(--radii-200);
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: -1px;
  }
</style>
