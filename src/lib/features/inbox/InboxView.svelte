<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import BookmarkSimpleIcon from 'phosphor-svelte/lib/BookmarkSimpleIcon';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import { type NotificationFilter, parseFilter } from './inbox';
  import InviteList from './InviteList.svelte';
  import NotificationList from './NotificationList.svelte';

  interface Props {
    variant?: 'page' | 'sheet';
    headingId?: string;
  }

  let { variant = 'page', headingId }: Props = $props();
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
      replace: true,
      reset: false,
    });
  }
</script>

<!-- eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the route renders the default page variant -->
{#if variant === 'page'}
  <AppPageShell title={$i18n.t('nav.inbox')} density="compact">
    {#snippet actions()}
      <a class="bookmarks-link" href={resolve('bookmarks')}>
        <BookmarkSimpleIcon aria-hidden="true" />
        {$i18n.t('inbox.bookmarks')}
      </a>
    {/snippet}
    <div class="inbox">
      <InviteList />
      <NotificationList {filter} onFilter={selectFilter} />
    </div>
  </AppPageShell>
{:else}
  <section class="inbox-sheet" aria-label={$i18n.t('nav.inbox')}>
    <header>
      <h2 id={headingId} tabindex="-1">{$i18n.t('nav.inbox')}</h2>
    </header>
    <div class="inbox">
      <NotificationList {filter} onFilter={selectFilter} limit={5} />
      <InviteList />
      <a class="view-all" href={resolve('inbox')}>{$i18n.t('inbox.viewAll')}</a>
    </div>
  </section>
{/if}

<style>
  .inbox {
    display: grid;
    gap: var(--space-500);
  }

  .inbox-sheet {
    display: grid;
    gap: var(--space-500);
    padding: var(--space-400);
  }

  .inbox-sheet header {
    align-items: center;
    background: var(--surface-container);
    display: flex;
    inset-block-start: 0;
    justify-content: space-between;
    margin: calc(var(--space-400) * -1) calc(var(--space-400) * -1) calc(var(--space-200) * -1);
    padding: var(--space-400) var(--space-400) var(--space-200);
    position: sticky;
    z-index: 1;
  }

  .inbox-sheet h2 {
    font-size: var(--font-size-heading);
    margin: 0;
  }

  .inbox-sheet h2:focus {
    outline: none;
  }

  .view-all {
    align-items: center;
    border-radius: var(--radius);
    display: flex;
    justify-content: center;
    min-height: var(--control-height-400);
  }

  .view-all:hover {
    background: var(--surface-container-hover);
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
</style>
