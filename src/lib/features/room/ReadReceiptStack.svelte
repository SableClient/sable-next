<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import { scale } from 'svelte/transition';
  import type { MemberView } from '#src/generated/MemberView';

  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  import { memberAvatar, memberName } from './members.js';
  import { senderColor } from './timeline-format';

  const MAX_FACES = 3;

  interface Props {
    readers: readonly string[];
    members: readonly MemberView[];
    expanded?: boolean;
    onOpen: (anchor: HTMLButtonElement) => void;
  }

  let { readers, members, expanded = false, onOpen }: Props = $props();
  let seen = $derived(
    readers.map((userId) => ({
      userId,
      name: memberName(members, userId),
      avatar: memberAvatar(members, userId),
    }))
  );
  let names = $derived(seen.map((reader) => reader.name).join(', '));
</script>

{#if readers.length > 0}
  <button
    class="read-receipt-stack"
    type="button"
    aria-label={$i18n.t('timeline.seenByNames', { names })}
    aria-haspopup="dialog"
    aria-expanded={expanded}
    title={names}
    onclick={(event) => {
      onOpen(event.currentTarget);
    }}
  >
    <span class="stack">
      {#each seen.slice(0, MAX_FACES) as reader (reader.userId)}
        <span
          transition:scale={{
            duration: prefersReducedMotion.current ? 0 : 200,
            start: 0.72,
            easing: cubicOut,
          }}
        >
          <Avatar
            class="receipt-face"
            src={reader.avatar}
            name={reader.name}
            color={senderColor(reader.userId)}
          />
        </span>
      {/each}
      {#if readers.length > MAX_FACES}
        <span class="overflow">+{readers.length - MAX_FACES}</span>
      {/if}
    </span>
  </button>
{/if}

<style>
  button {
    --stack-ring: var(--sable-bg-container);

    align-items: center;
    background: transparent;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-pill);
    color: var(--sable-sec-main);
    cursor: pointer;
    display: inline-flex;
    flex: none;
    font: inherit;
    gap: var(--space-150);
    height: 1.375rem;
    max-width: 100%;
    padding: 0 var(--space-150);
    position: relative;
    transition:
      background-color var(--motion-fast) var(--motion-easing-standard),
      border-color var(--motion-fast) var(--motion-easing-standard),
      color var(--motion-fast) var(--motion-easing-standard);
    white-space: nowrap;
  }

  button::after {
    content: '';
    inset: -0.25rem 0;
    position: absolute;
  }

  button:hover {
    --stack-ring: var(--sable-bg-container-hover);

    background: var(--sable-bg-container-hover);
    border-color: var(--sable-bg-container-line);
    color: var(--sable-surface-var-on-container);
  }

  button:active {
    --stack-ring: var(--sable-surface-var-container);

    background: var(--sable-surface-var-container);
    border-color: var(--sable-surface-container-line);
    color: var(--sable-surface-var-on-container);
  }

  button[aria-expanded='true'] {
    --stack-ring: var(--sable-surface-container);

    background: var(--sable-surface-container);
    border-color: var(--sable-surface-container-line);
    color: var(--sable-surface-var-on-container);
  }

  button:focus-visible {
    color: var(--sable-surface-var-on-container);
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: 0.15rem;
  }

  .stack {
    align-items: center;
    display: flex;
    flex: none;
    padding-left: var(--space-050);
  }

  .stack > * + * {
    margin-left: calc(-1 * var(--space-150));
  }

  .stack :global(.receipt-face) {
    box-shadow: 0 0 0 0.125rem var(--stack-ring);
  }

  :global(.sable-avatar.receipt-face) {
    --avatar-size: 1.125rem;

    font-size: var(--font-size-small);
  }

  .overflow {
    align-items: center;
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    box-shadow: 0 0 0 0.125rem var(--stack-ring);
    color: var(--sable-surface-var-on-container);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    height: 1.125rem;
    justify-content: center;
    line-height: 1;
    min-width: 1.125rem;
    padding: 0 var(--space-050);
  }
</style>
