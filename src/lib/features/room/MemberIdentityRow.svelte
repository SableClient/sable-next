<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';
  import type { MemberView } from '#src/generated/MemberView';
  import type { ProfileView } from '#src/generated/ProfileView';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';

  import { memberAvatar, memberName, senderDisplayColors } from './members.js';
  import SenderName from './SenderName.svelte';
  import { senderColor } from './timeline-format';

  interface Props {
    userId: string;
    members: readonly MemberView[];
    class?: ClassValue;
    onProfile?: (userId: string, anchor: HTMLElement) => void;
    trailing?: Snippet;
  }

  let { userId, members, class: className = '', onProfile, trailing }: Props = $props();
  const core = useCoreClient();
  let profile = $state<ProfileView | null>(null);
  let displayName = $derived(memberName(members, userId));
  let avatarUrl = $derived(memberAvatar(members, userId));
  let colors = $derived(senderDisplayColors(userId, profile));
  let avatarColor = $derived(avatarUrl ? undefined : senderColor(userId));
  let profileLabel = $derived($i18n.t('timeline.senderProfile', { name: displayName }));

  $effect(() => {
    profile = null;
    let current = true;
    void core.userProfile(userId).then(
      (next) => {
        if (current) profile = next;
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  });

  function openProfile(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    onProfile?.(userId, event.currentTarget);
  }
</script>

{#snippet identity()}
  <Avatar src={avatarUrl} name={displayName} color={avatarColor} size="small" />
  <div class="member-identity-main">
    <SenderName {displayName} {colors} nameClass="member-name" compact />
    {#if trailing}
      <span class="member-identity-trailing">{@render trailing()}</span>
    {/if}
  </div>
{/snippet}

{#if onProfile}
  <button
    type="button"
    class={['member-identity-row', 'member-identity-button', className]}
    aria-label={profileLabel}
    onclick={openProfile}
  >
    {@render identity()}
  </button>
{:else}
  <div class={['member-identity-row', className]}>
    {@render identity()}
  </div>
{/if}

<style>
  .member-identity-row {
    align-items: center;
    color: inherit;
    display: flex;
    gap: var(--space-250);
    min-width: 0;
    text-align: left;
    width: 100%;
  }

  .member-identity-button {
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    cursor: pointer;
    font: inherit;
    padding: 0;
  }

  .member-identity-button:hover {
    background: var(--sable-surface-container);
  }

  .member-identity-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .member-identity-main {
    align-items: center;
    display: flex;
    flex: 1;
    gap: var(--space-200);
    min-width: 0;
  }

  .member-identity-trailing {
    align-items: center;
    color: var(--sable-surface-var-on-container);
    display: inline-flex;
    flex: none;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    margin-left: auto;
  }
</style>
