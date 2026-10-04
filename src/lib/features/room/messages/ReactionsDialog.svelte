<script lang="ts">
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import type { ImagePackView, MemberView, ReactionGroup } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { useCoreClient } from '#lib/core/context.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import {
    isCustomReaction,
    loadReactionEmotePacks,
    reactionEmoteLabel,
  } from './reaction-emote-label.js';
  import TabbedMemberListDialog from '../members/TabbedMemberListDialog.svelte';
  import { memberName } from '../members/members.js';
  import { redactReaction } from './redact-reaction.js';

  interface Props {
    open?: boolean;
    reactions: readonly ReactionGroup[];
    roomId: string;
    eventId: string | null;
    members: readonly MemberView[];
    currentUserId?: string | null;
    canRedactOwn?: boolean;
    canRedactOthers?: boolean;
    active?: number;
    onMemberProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    open = $bindable(false),
    reactions,
    roomId,
    eventId,
    members,
    currentUserId = null,
    canRedactOwn = false,
    canRedactOthers = false,
    active = $bindable(0),
    onMemberProfile,
  }: Props = $props();
  const core = useCoreClient();
  let imagePacks = $state.raw<ImagePackView[]>([]);
  let deleting = $state<{ key: string; sender: string } | null>(null);

  function canRemove(sender: string): boolean {
    return eventId !== null && (sender === currentUserId ? canRedactOwn : canRedactOthers);
  }

  async function remove(key: string, sender: string): Promise<void> {
    if (!eventId || !canRemove(sender) || deleting) return;
    deleting = { key, sender };
    try {
      await redactReaction(core.commands, roomId, eventId, key, sender);
    } catch (error) {
      console.warn('[sable timeline] reaction redaction failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    } finally {
      deleting = null;
    }
  }

  $effect(() => {
    let current = true;
    void loadReactionEmotePacks(roomId, core.commands.imagePacks)
      .then((packs) => {
        if (current) imagePacks = packs;
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  });
</script>

<TabbedMemberListDialog
  bind:open
  bind:active
  title={$i18n.t('timeline.viewReactions')}
  tabs={reactions}
  tabKey={(reaction) => reaction.key}
  userIds={(reaction) => reaction.senders}
  {members}
  {onMemberProfile}
>
  {#snippet tab(reaction)}
    {#if isCustomReaction(reaction.key)}
      <MediaImage
        class="reaction-image"
        source={reaction.key}
        alt={reactionEmoteLabel(reaction.key, imagePacks, $i18n.t('timeline.customEmote'))}
        width={64}
        height={64}
        original
      />
    {:else}
      <em>{reaction.key}</em>
    {/if}
  {/snippet}
  {#snippet memberAction(reaction, sender)}
    {#if canRemove(sender)}
      <IconButton
        class="reaction-delete"
        variant="ghost"
        label={$i18n.t('timeline.removeReaction', { name: memberName(members, sender) })}
        loading={deleting?.key === reaction.key && deleting.sender === sender}
        disabled={deleting !== null}
        onclick={() => {
          void remove(reaction.key, sender);
        }}
      >
        <TrashIcon />
      </IconButton>
    {/if}
  {/snippet}
</TabbedMemberListDialog>

<style>
  :global(.member-list-dialog .reaction-delete) {
    color: var(--crit-main);
    flex-shrink: 0;
  }

  :global(.member-list-tab .reaction-image) {
    display: block;
    height: 1.125rem;
    max-width: 9.375rem;
    object-fit: contain;
    width: calc(1.125rem * var(--media-ratio));
  }
</style>
