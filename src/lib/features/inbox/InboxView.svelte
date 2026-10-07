<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { Tabs } from 'bits-ui';
  import BookmarkSimpleIcon from 'phosphor-svelte/lib/BookmarkSimpleIcon';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import {
    type InboxTab,
    type NotificationFilter,
    parseFilter,
    parseInboxTab,
    pendingInvites,
  } from './inbox';
  import InviteList from './InviteList.svelte';
  import JoinRequestList from './JoinRequestList.svelte';
  import NotificationList from './NotificationList.svelte';

  const roomList = useRoomList();
  let tab = $derived<InboxTab>(parseInboxTab(page.url.searchParams.get('tab')));
  let filter = $derived(parseFilter(page.url.searchParams.get('filter')));

  function selectTab(value: string): void {
    const url = new URL(page.url.href);
    if (value === 'notifications') url.searchParams.delete('tab');
    else url.searchParams.set('tab', value);
    void goto(`${url.pathname}${url.search}`, { replace: true, reset: false });
  }

  function selectFilter(value: NotificationFilter): void {
    const url = new URL(page.url.href);
    if (value === 'all') url.searchParams.delete('filter');
    else url.searchParams.set('filter', value);

    void goto(`${url.pathname}${url.search}`, {
      replace: true,
      reset: false,
    });
  }
</script>

<AppPageShell title={$i18n.t('nav.inbox')} density="compact">
  {#snippet actions()}
    <a class="bookmarks-link" href={resolve('bookmarks')} draggable="false">
      <BookmarkSimpleIcon aria-hidden="true" />
      {$i18n.t('inbox.bookmarks')}
    </a>
  {/snippet}
  <Tabs.Root bind:value={tab} onValueChange={selectTab} class="inbox">
    <Tabs.List class="inbox-tabs" aria-label={$i18n.t('nav.inbox')}>
      <Tabs.Trigger value="notifications" class="inbox-tab">
        {$i18n.t('inbox.notifications')}
      </Tabs.Trigger>
      <Tabs.Trigger value="invites" class="inbox-tab">
        {$i18n.t('inbox.invitesTab')}
      </Tabs.Trigger>
      <Tabs.Trigger value="requests" class="inbox-tab">
        {$i18n.t('room.membersRequests')}
      </Tabs.Trigger>
    </Tabs.List>
    <Tabs.Content value="notifications">
      <NotificationList {filter} onFilter={selectFilter} />
    </Tabs.Content>
    <Tabs.Content value="invites">
      <InviteList />
      {#if pendingInvites(roomList.rooms).length === 0}
        <p class="empty">{$i18n.t('inbox.invitesEmpty')}</p>
      {/if}
    </Tabs.Content>
    <Tabs.Content value="requests">
      <JoinRequestList />
    </Tabs.Content>
  </Tabs.Root>
</AppPageShell>

<style>
  :global(.inbox) {
    display: grid;
    gap: var(--space-300);
  }

  :global(.inbox-tabs) {
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  :global(.inbox-tab) {
    background: transparent;
    border: 0;
    border-bottom: var(--border-width-500) solid transparent;
    color: var(--surface-var-on-container);
    cursor: pointer;
    font: inherit;
    min-height: var(--control-height-400);
    padding: var(--space-200) var(--space-100);
  }

  :global(.inbox-tab[data-state='active']) {
    border-bottom-color: var(--primary-main);
    color: var(--primary-main);
    font-weight: var(--font-weight-medium);
  }

  :global(.inbox-tab:hover) {
    background: var(--surface-container-hover);
  }

  .empty {
    color: var(--surface-var-on-container);
    margin: 0;
    text-align: center;
  }

  .bookmarks-link {
    align-items: center;
    display: inline-flex;
    gap: var(--space-200);
  }

  .bookmarks-link :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  @media (pointer: coarse) {
    :global(.inbox-tab) {
      min-height: 2.75rem;
    }
  }
</style>
