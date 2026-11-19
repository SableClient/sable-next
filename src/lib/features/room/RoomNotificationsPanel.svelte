<script lang="ts">
  import type { MemberView } from '#src/generated/protocol';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SearchField from '#lib/ui/primitives/SearchField.svelte';

  import RoomNotifications from './RoomNotifications.svelte';
  import RoomSidePanel from './RoomSidePanel.svelte';

  interface Props {
    roomId: string;
    members: readonly MemberView[];
    onJump: (eventId: string) => void;
    modal?: boolean;
    onClose: () => void;
  }

  const filters = [
    { value: 'all', label: 'inbox.filterAll' },
    { value: 'mentions', label: 'inbox.filterMentions' },
  ] as const;

  let { roomId, members, onJump, modal = false, onClose }: Props = $props();

  let filter = $state<'mentions' | 'all'>('all');
  let query = $state('');
</script>

<RoomSidePanel
  title={i18n.t('inbox.notifications')}
  closeLabel={i18n.t('room.notificationsClose')}
  resizeLabel={i18n.t('room.notificationsResize')}
  widthKey="sable-room-notifications-width"
  width={22}
  body="flush"
  {modal}
  {onClose}
>
  {#snippet toolbar()}
    <div class="filters" role="group" aria-label={i18n.t('inbox.filterLabel')}>
      {#each filters as option (option.value)}
        <Button
          variant="ghost"
          size="small"
          class="choice"
          aria-pressed={option.value === filter}
          onclick={() => (filter = option.value)}
        >
          {i18n.t(option.label)}
        </Button>
      {/each}
    </div>
    <SearchField bind:value={query} label={i18n.t('room.notificationsSearch')} />
  {/snippet}
  <RoomNotifications {roomId} {members} {filter} {query} {onJump} />
</RoomSidePanel>

<style>
  .filters {
    display: flex;
    gap: var(--space-200);
  }
</style>
