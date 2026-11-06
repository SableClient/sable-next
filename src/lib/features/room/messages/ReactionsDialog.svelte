<script lang="ts">
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import ReplyIcon from 'phosphor-svelte/lib/ArrowBendUpLeftIcon';
  import type { MemberView, ReactionGroup } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { RoomPacks } from '#lib/emoji/room-packs.svelte.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { isCustomReaction, reactionEmoteLabel, reactionText } from './reaction-emote-label.js';
  import TabbedMemberListDialog from '../members/TabbedMemberListDialog.svelte';
  import { memberName } from '../members/members.js';
  import { fetchReaction, redactReaction } from './redact-reaction.js';
  import type { MessageCallbacks } from './message-action-controller.svelte.js';

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
    onReply?: MessageCallbacks['onReply'];
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
    onReply,
  }: Props = $props();
  const core = useCoreClient();
  const packs = new RoomPacks(core, () => roomId);
  let action = $state<{ key: string; sender: string; action: 'delete' | 'reply' } | null>(null);

  function canRemove(sender: string): boolean {
    return eventId !== null && (sender === currentUserId ? canRedactOwn : canRedactOthers);
  }

  async function remove(key: string, sender: string): Promise<void> {
    if (!eventId || !canRemove(sender) || action) return;
    action = { key, sender, action: 'delete' };
    try {
      await redactReaction(core, roomId, eventId, key, sender);
    } catch (error) {
      console.warn('[sable timeline] reaction redaction failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    } finally {
      action = null;
    }
  }

  async function reply(
    key: string,
    sender: string,
    onReply: NonNullable<MessageCallbacks['onReply']>
  ): Promise<void> {
    if (!eventId || action) return;
    action = { key, sender, action: 'reply' };
    try {
      const events = await fetchReaction(core, roomId, eventId, key, sender);
      const event = events.values().next().value;
      if (event === undefined) {
        throw new Error('failed to fetch reaction event');
      }
      onReply(event);
      open = false;
    } catch (error) {
      console.warn('[sable timeline] reaction reply failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    } finally {
      action = null;
    }
  }
</script>

<TabbedMemberListDialog
  bind:open
  bind:active
  title={i18n.t('timeline.viewReactions')}
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
        alt={reactionEmoteLabel(reaction.key, packs.current, i18n.t('timeline.customEmote'))}
        width={64}
        height={64}
        original
        emoticon
      />
    {:else}
      <em>{reactionText(reaction.key)}</em>
    {/if}
  {/snippet}
  {#snippet memberAction(reaction, sender)}
    {#if onReply}
      <IconButton
        class="reaction-reply"
        variant="ghost"
        label={i18n.t('timeline.reply')}
        loading={action?.action === 'reply' &&
          action.key === reaction.key &&
          action.sender === sender}
        disabled={action !== null}
        onclick={() => {
          void reply(reaction.key, sender, onReply);
        }}
      >
        <ReplyIcon />
      </IconButton>
    {/if}
    {#if canRemove(sender)}
      <IconButton
        class="reaction-delete"
        variant="ghost"
        label={i18n.t('timeline.removeReaction', { name: memberName(members, sender) })}
        loading={action?.action === 'delete' &&
          action.key === reaction.key &&
          action.sender === sender}
        disabled={action !== null}
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
