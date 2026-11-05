<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';
  import type { MemberView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { UserProfile } from '#lib/profile/user-profile.svelte.js';
  import { useRoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { resolveUserStatus } from '#lib/rooms/user-status.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';

  import { findMember, senderDisplayColors } from './members.js';
  import SenderName from './SenderName.svelte';
  import type { PowerLevelTag } from '../settings/power-level-tags.js';

  interface Props {
    userId: string;
    members: readonly MemberView[];
    class?: ClassValue;
    onProfile?: (userId: string, anchor: HTMLElement) => void;
    showStatus?: boolean;
    powerTag?: PowerLevelTag | null;
    trailing?: Snippet;
    secondary?: Snippet;
  }

  let {
    userId,
    members,
    class: className = '',
    onProfile,
    showStatus = false,
    powerTag = null,
    trailing,
    secondary,
  }: Props = $props();
  const core = useCoreClient();
  const profileDescriptionId = $props.id();
  const presenceStore = usePresenceStore();
  const roomCosmetics = useRoomCosmetics();
  const profile = new UserProfile(core, () => userId);
  let member = $derived(findMember(members, userId));
  let shown = $derived(member ?? profile.current);
  let displayName = $derived(shown?.display_name ?? userId);
  let avatarUrl = $derived(shown?.avatar_url ?? null);
  let cosmetics = $derived(roomCosmetics?.for(userId) ?? null);
  let colors = $derived(
    senderDisplayColors(userId, profile.current, null, false, cosmetics, powerTag?.color ?? null)
  );
  let profileLabel = $derived(i18n.t('timeline.senderProfile', { name: displayName }));
  let presence = $derived(presenceStore.peek(userId));
  let userStatus = $derived(showStatus ? resolveUserStatus(profile.current, presence) : null);

  function openProfile(event: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    onProfile?.(userId, event.currentTarget);
  }
</script>

{#snippet identity()}
  <span class="member-identity-avatar">
    <Avatar
      src={avatarUrl}
      name={displayName}
      id={userId}
      size="small"
      decorative
      initialsAsDecoration
    />
    {#if presence && presence.presence !== 'offline'}
      <PresenceDot
        presence={presence.presence}
        label={i18n.t(`presence.${presence.presence}`)}
        class="member-identity-presence"
        size="medium"
      />
    {/if}
  </span>
  <div class="member-identity-main">
    <span class="member-identity-text">
      <SenderName {displayName} {colors} nameClass="member-name" compact />
      {@render secondary?.()}
      {#if userStatus}
        {@const statusLabel = [userStatus?.emoji, userStatus?.text].filter(Boolean).join(' ')}
        <Tooltip label={statusLabel}>
          {#snippet trigger({ props })}
            <span {...props} class="member-identity-status">
              {#if userStatus?.emoji}<span class="member-identity-status-emoji"
                  >{userStatus.emoji}</span
                >{/if}{userStatus?.text}
            </span>
          {/snippet}
        </Tooltip>
      {/if}
    </span>
    {#if trailing}
      <span class="member-identity-trailing">{@render trailing()}</span>
    {/if}
  </div>
{/snippet}

{#if onProfile}
  <button
    type="button"
    class={['member-identity-row', 'member-identity-button', className]}
    aria-label={displayName}
    aria-describedby={profileDescriptionId}
    onclick={openProfile}
  >
    {@render identity()}
    <span id={profileDescriptionId} class="screen-reader-only">{profileLabel}</span>
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
    font-size: var(--font-size-label);
    gap: var(--space-300);
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
    background: var(--surface-container);
    color: var(--surface-on-container);
  }

  .member-identity-button:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .member-identity-avatar {
    display: inline-flex;
    flex: none;
    position: relative;
  }

  .member-identity-avatar :global(.member-identity-presence) {
    bottom: -0.125rem;
    position: absolute;
    right: -0.125rem;
  }

  .member-identity-main {
    align-items: center;
    display: flex;
    flex: 1;
    gap: var(--space-200);
    min-width: 0;
  }

  .member-identity-text {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .member-identity-status {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .member-identity-status-emoji {
    margin-right: var(--space-050);
  }

  .member-identity-trailing {
    align-items: center;
    color: var(--surface-var-on-container);
    display: inline-flex;
    flex: none;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    margin-left: auto;
  }
</style>
