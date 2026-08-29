<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import { type NotificationFilter, parseFilter } from './inbox';
  import BookmarkList from './BookmarkList.svelte';
  import InviteList from './InviteList.svelte';
  import NotificationList from './NotificationList.svelte';

  interface Props {
    variant?: 'page' | 'sheet';
  }

  let { variant = 'page' }: Props = $props();
  let previewFilter = $state<NotificationFilter>(parseFilter(page.url.searchParams.get('filter')));
  let filter = $derived(
    page.state.inbox ? previewFilter : parseFilter(page.url.searchParams.get('filter'))
  );

  function selectFilter(value: NotificationFilter): void {
    if (page.state.inbox) {
      previewFilter = value;
      return;
    }

    const url = new URL(resolve('inbox'), page.url.origin);
    if (value === 'all') url.searchParams.delete('filter');
    else url.searchParams.set('filter', value);

    void goto(`${url.pathname}${url.search}`, {
      replaceState: true,
      reset: false,
    });
  }
</script>

<!-- eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the route renders the default page variant -->
{#if variant === 'page'}
  <AppPageShell title={$i18n.t('nav.inbox')} density="compact">
    <div class="inbox">
      <InviteList />
      <NotificationList {filter} onFilter={selectFilter} />
      <BookmarkList />
    </div>
  </AppPageShell>
{:else}
  <section class="inbox-sheet" aria-label={$i18n.t('nav.inbox')}>
    <header>
      <h2>{$i18n.t('nav.inbox')}</h2>
    </header>
    <div class="inbox">
      <InviteList />
      <NotificationList {filter} onFilter={selectFilter} limit={5} />
      <a class="view-all" href="/inbox">{$i18n.t('inbox.viewAll')}</a>
    </div>
  </section>
{/if}

<style>
  .inbox {
    display: grid;
    gap: var(--space-4);
  }

  .inbox-sheet {
    display: grid;
    gap: var(--space-4);
    padding: 0 var(--space-300) var(--space-3) var(--space-400);
  }

  .inbox-sheet header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .inbox-sheet h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .view-all {
    justify-self: end;
  }
</style>
