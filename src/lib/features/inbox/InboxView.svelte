<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { i18n } from '#lib/i18n.js';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { type NotificationFilter, parseFilter } from './inbox';
  import InviteList from './InviteList.svelte';
  import NotificationList from './NotificationList.svelte';

  interface Props {
    onClose?: () => void;
  }

  let { onClose }: Props = $props();
  let filter = $derived(parseFilter(page.url.searchParams.get('filter')));

  function selectFilter(value: NotificationFilter): void {
    const url = new URL(page.url.href);
    if (value === 'all') url.searchParams.delete('filter');
    else url.searchParams.set('filter', value);

    void goto(`${url.pathname}${url.search}`, {
      replaceState: true,
      reset: false,
      ...(page.state.inbox ? { shallow: true, state: { inbox: true } } : {}),
    });
  }
</script>

<AppPageShell title={$i18n.t('nav.inbox')} density="compact">
  {#snippet actions()}
    {#if onClose}
      <IconButton variant="ghost" size="small" label={$i18n.t('settings.close')} onclick={onClose}>
        <XIcon />
      </IconButton>
    {/if}
  {/snippet}
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
