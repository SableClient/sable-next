<script lang="ts">
  import PulseIcon from 'phosphor-svelte/lib/PulseIcon';
  import type { PresenceUserSharingView } from '#src/generated/protocol';

  import { i18n } from '#lib/i18n.js';
  import { presenceSharing } from '#lib/rooms/presence-sharing.svelte.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSub from '#lib/ui/primitives/ActionMenuSub.svelte';

  interface Props {
    userId: string;
  }

  let { userId }: Props = $props();

  let presenceChoices = $derived([
    { sharing: null, label: i18n.t('timeline.profilePresenceDefault') },
    { sharing: 'allow' as const, label: i18n.t('timeline.profilePresenceAllow') },
    { sharing: 'deny' as const, label: i18n.t('timeline.profilePresenceDeny') },
  ]);
  let presenceChoice = $derived(presenceSharing.userSharing(userId));

  function setPresenceSharing(sharing: PresenceUserSharingView | null): void {
    presenceSharing.edit({ kind: 'user', user_id: userId, sharing }).catch((error: unknown) => {
      console.warn('[sable profile] presence sharing not changed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    });
  }
</script>

{#if presenceSharing.supported}
  <ActionMenuSub label={i18n.t('timeline.profilePresenceSharing')}>
    {#snippet trigger()}
      <PulseIcon />
      {i18n.t('timeline.profilePresenceSharing')}
    {/snippet}
    {#each presenceChoices as choice (choice.label)}
      <ActionMenuItem
        checked={presenceChoice === choice.sharing}
        onSelect={() => {
          setPresenceSharing(choice.sharing);
        }}
      >
        {choice.label}
      </ActionMenuItem>
    {/each}
  </ActionMenuSub>
{/if}
