<script lang="ts">
  import type { ImagePackView, MemberView, ReactionGroup } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { useCoreClient } from '#lib/core/context.js';
  import MediaImage from '#lib/ui/MediaImage.svelte';

  import {
    isCustomReaction,
    loadReactionEmotePacks,
    reactionEmoteLabel,
  } from './reaction-emote-label.js';
  import TabbedMemberListDialog from './TabbedMemberListDialog.svelte';

  interface Props {
    open?: boolean;
    reactions: readonly ReactionGroup[];
    roomId: string;
    members: readonly MemberView[];
    active?: number;
    onMemberProfile?: (userId: string, anchor: HTMLElement) => void;
  }

  let {
    open = $bindable(false),
    reactions,
    roomId,
    members,
    active = $bindable(0),
    onMemberProfile,
  }: Props = $props();
  const core = useCoreClient();
  let imagePacks = $state.raw<ImagePackView[]>([]);

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
</TabbedMemberListDialog>

<style>
  :global(.member-list-tab .reaction-image) {
    height: 1.125rem;
    object-fit: contain;
    width: auto;
  }
</style>
