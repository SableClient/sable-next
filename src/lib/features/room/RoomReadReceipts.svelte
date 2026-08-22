<script lang="ts">
  import { Popover } from 'bits-ui';
  import { cubicOut } from 'svelte/easing';
  import { prefersReducedMotion } from 'svelte/motion';
  import { scale } from 'svelte/transition';
  import type { MemberView } from '#src/generated/MemberView';

  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import BottomSheet from '#lib/ui/primitives/BottomSheet.svelte';

  import MembersDrawer from './MembersDrawer.svelte';
  import { initials, senderColor } from './timeline-format';

  const MAX_FACES = 3;

  interface Props {
    readers: readonly string[];
    members: readonly MemberView[];
    loading: boolean;
    visible?: boolean;
    open?: boolean;
    onMemberProfile: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    readers,
    members,
    loading,
    visible = true,
    open = $bindable(false),
    onMemberProfile,
  }: Props = $props();
  let anchor = $state<HTMLButtonElement | null>(null);
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  let desktop = $derived(appLayout.matches);
  let seen = $derived(
    readers.map((userId) => {
      const member = members.find((entry) => entry.user_id === userId);
      return {
        userId,
        name: member?.display_name ?? localPart(userId),
        avatar: member?.avatar_url,
      };
    })
  );
  let names = $derived(seen.map((reader) => reader.name).join(', '));

  $effect(() => {
    // Losing the readers unmounts the anchor, which would drop a desktop
    // popover through to the bottom sheet branch.
    if (!visible || readers.length === 0) open = false;
  });

  function localPart(userId: string): string {
    const match = /^@?([^:]+)(?::.*)?$/.exec(userId);
    return match?.[1] ?? userId;
  }
</script>

<div class="room-read-receipts">
  {#if visible && readers.length > 0}
    <button
      type="button"
      aria-label={$i18n.t('timeline.seenByNames', { names })}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={names}
      bind:this={anchor}
      onclick={() => {
        open = true;
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
              initials={initials(reader.name)}
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
</div>

{#if desktop && anchor}
  <Popover.Root bind:open>
    <Popover.Portal>
      <Popover.Content class="read-receipts-popover" customAnchor={anchor} side="top" align="end">
        <MembersDrawer
          {members}
          {loading}
          compact
          searchable={false}
          title={$i18n.t('timeline.seenBy')}
          onClose={() => {
            open = false;
          }}
          {onMemberProfile}
        />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
{:else}
  <BottomSheet
    bind:open
    label={$i18n.t('timeline.readReceipts')}
    closeLabel={$i18n.t('timeline.closeReadReceipts')}
  >
    <MembersDrawer
      {members}
      {loading}
      compact
      searchable={false}
      title={$i18n.t('timeline.seenBy')}
      onClose={() => {
        open = false;
      }}
      {onMemberProfile}
    />
  </BottomSheet>
{/if}

<style>
  .room-read-receipts {
    align-items: center;
    display: flex;
    justify-content: flex-end;
    min-width: 0;

    --stack-ring: var(--sable-bg-container);
  }

  button {
    align-items: center;
    background: transparent;
    border: var(--border-width) solid transparent;
    border-radius: var(--radius-pill);
    color: var(--sable-sec-main);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    gap: var(--space-tight);
    height: 1.375rem;
    max-width: 100%;
    padding: 0 var(--space-tight);
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
    padding-left: 0.125rem;
  }

  .stack > * + * {
    margin-left: -0.375rem;
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
    padding: 0 0.1875rem;
  }

  :global(.read-receipts-popover) {
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    box-shadow: var(--shadow-dialog);
    display: flex;
    max-height: min(28rem, calc(100dvh - 2rem));
    overflow: hidden;
    padding: 0;
    width: min(22rem, calc(100vw - 2rem));
    z-index: var(--layer-popover);
  }

  :global(.read-receipts-popover .members-drawer) {
    max-height: 100%;
    min-height: 0;
  }
</style>
