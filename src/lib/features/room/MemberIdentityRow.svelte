<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { ClassValue } from 'svelte/elements';
  import type { MemberView, ProfileView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { pronounPillLength, pronounPillLimit, visiblePronouns } from '#lib/personas/pronouns.js';
  import { useRoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { usePresenceStore } from '#lib/rooms/presence.svelte.js';
  import { resolveUserStatus } from '#lib/rooms/user-status.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import PresenceDot from '#lib/ui/primitives/PresenceDot.svelte';

  import { findMember, senderDisplayColors } from './members.js';
  import RoleTagIcon from './RoleTagIcon.svelte';
  import SenderName from './SenderName.svelte';
  import type { PowerLevelTag } from './settings/power-level-tags.js';

  interface Props {
    userId: string;
    members: readonly MemberView[];
    class?: ClassValue;
    onProfile?: (userId: string, anchor: HTMLElement) => void;
    showStatus?: boolean;
    powerTag?: PowerLevelTag | null;
    trailing?: Snippet;
  }

  let {
    userId,
    members,
    class: className = '',
    onProfile,
    showStatus = false,
    powerTag = null,
    trailing,
  }: Props = $props();
  const core = useCoreClient();
  const presenceStore = usePresenceStore();
  const roomCosmetics = useRoomCosmetics();
  let profile = $state<ProfileView | null>(null);
  let member = $derived(findMember(members, userId));
  let displayName = $derived(member?.display_name ?? profile?.display_name ?? userId);
  let avatarUrl = $derived(member?.avatar_url ?? profile?.avatar_url ?? null);
  let cosmetics = $derived(roomCosmetics?.for(userId) ?? null);
  let colors = $derived.by(() => {
    const profileColors = senderDisplayColors(userId, profile, null, false, cosmetics);
    if (profileColors.tinted || !powerTag?.color) return profileColors;
    return {
      ...profileColors,
      nameColorLight: powerTag.color,
      nameColorDark: powerTag.color,
      tinted: true,
    };
  });
  let pronouns = $derived(
    visiblePronouns(
      preferences.showPronouns
        ? cosmetics?.pronouns.length
          ? cosmetics.pronouns
          : (profile?.pronouns ?? [])
        : [],
      {
        language: $i18n.resolvedLanguage ?? $i18n.language,
        filterByLanguage: preferences.filterPronounsByLanguage,
        limit: pronounPillLimit(preferences.pronounPillLimit),
        maxLength: pronounPillLength(preferences.pronounPillLength),
      }
    )
  );
  let profileLabel = $derived($i18n.t('timeline.senderProfile', { name: displayName }));
  let presence = $derived(presenceStore.get(userId));
  let userStatus = $derived(showStatus ? resolveUserStatus(profile, presence) : null);

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
  <span class="member-identity-avatar">
    <Avatar src={avatarUrl} name={displayName} id={userId} size="small" />
    {#if presence && presence.presence !== 'offline'}
      <PresenceDot
        presence={presence.presence}
        label={$i18n.t(`presence.${presence.presence}`)}
        class="member-identity-presence"
        size="medium"
      />
    {/if}
  </span>
  <div class="member-identity-main">
    <span class="member-identity-text">
      <SenderName
        {displayName}
        {colors}
        {pronouns}
        font={cosmetics?.font}
        nameClass="member-name"
        compact={pronouns.visible.length === 0}
      />
      {#if powerTag?.icon}
        <RoleTagIcon icon={powerTag.icon} class="member-identity-role-icon" />
      {/if}
      {#if userStatus}
        <span class="member-identity-status">
          {#if userStatus.emoji}<span class="member-identity-status-emoji">{userStatus.emoji}</span
            >{/if}{userStatus.text}
        </span>
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

  :global(.member-identity-role-icon) {
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    line-height: 1;
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
