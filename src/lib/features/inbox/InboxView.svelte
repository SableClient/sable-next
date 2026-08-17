<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import AppPageShell from '$lib/ui/primitives/AppPageShell.svelte';
  import { type NotificationFilter, parseFilter } from './inbox';
  import InviteList from './InviteList.svelte';
  import NotificationList from './NotificationList.svelte';

  let filter = $derived(parseFilter(page.url.searchParams.get('filter')));

  /** In the URL, so a filtered inbox is linkable and survives a reload. */
  function selectFilter(value: NotificationFilter): void {
    const url = new URL(page.url);
    if (value === 'all') url.searchParams.delete('filter');
    else url.searchParams.set('filter', value);

    // eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query changes
    void goto(`${url.pathname}${url.search}`, {
      replaceState: true,
      noScroll: true,
      keepFocus: true,
    });
  }
</script>

<AppPageShell title={$i18n.t('nav.inbox')} density="compact">
  <div class="inbox">
    <InviteList />
    <NotificationList {filter} onFilter={selectFilter} />
  </div>
</AppPageShell>

<style>
  .inbox {
    display: grid;
    gap: var(--space-4);
  }
</style>
