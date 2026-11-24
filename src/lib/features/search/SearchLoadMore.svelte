<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { whenVisible } from '#lib/ui/when-visible.js';

  import type { MessageSearch } from './message-search.svelte.js';
  import SearchRetryAlert from './SearchRetryAlert.svelte';

  interface Props {
    search: MessageSearch;
  }

  let { search }: Props = $props();
</script>

{#if search.pageFailed || search.failed}
  <SearchRetryAlert
    message={i18n.t(search.pageFailed ? 'search.loadFailed' : 'search.refreshFailed')}
    disabled={search.searching}
    onRetry={() => {
      if (search.pageFailed) void search.retryPage();
      else search.refresh();
    }}
  />
{:else if !search.exhausted}
  <div class="load-more">
    <div
      class="load-sentinel"
      aria-hidden="true"
      {@attach (node) => {
        void search.pages;
        return whenVisible(() => void search.loadMore())(node);
      }}
    ></div>
    <Button
      variant="ghost"
      size="small"
      disabled={search.searching}
      onclick={() => void search.loadMore()}
    >
      {search.searching ? i18n.t('search.searching') : i18n.t('search.loadMore')}
    </Button>
  </div>
{/if}

<style>
  .load-more {
    align-items: flex-start;
    display: flex;
    flex-direction: column;
  }

  .load-sentinel {
    block-size: 1px;
    inline-size: 100%;
  }
</style>
